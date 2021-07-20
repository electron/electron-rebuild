import * as debug from 'debug';
import * as detectLibc from 'detect-libc';
import * as fs from 'fs-extra';
import * as NodeGyp from 'node-gyp';
import * as path from 'path';
import { fromElectronVersion as napiVersionFromElectronVersion } from 'node-api-version';
import { cacheModuleState } from './cache';
import { promisify } from 'util';
import { readPackageJson } from './read-package-json';
import { Rebuilder } from './rebuild';
import { spawn } from '@malept/cross-spawn-promise';
import { ELECTRON_GYP_DIR } from './constants';
import { getClangEnvironmentVars } from './clang-fetcher';

const d = debug('electron-rebuild');

const locateBinary = async (basePath: string, suffix: string): Promise<string | null> => {
  let parentPath = basePath;
  let testPath: string | undefined;

  while (testPath !== parentPath) {
    testPath = parentPath;
    const checkPath = path.resolve(testPath, suffix);
    if (await fs.pathExists(checkPath)) {
      return checkPath;
    }
    parentPath = path.resolve(testPath, '..');
  }

  return null;
};

async function locatePrebuild(modulePath: string): Promise<string | null> {
  return await locateBinary(modulePath, 'node_modules/prebuild-install/bin.js');
}

type PackageJSONValue = string | Record<string, unknown>;

export enum BuildType {
  Debug = 'Debug',
  Release = 'Release',
}

export class ModuleRebuilder {
  private modulePath: string;
  private packageJSON: Record<string, PackageJSONValue | undefined>;
  private rebuilder: Rebuilder;

  constructor(rebuilder: Rebuilder, modulePath: string) {
    this.modulePath = modulePath;
    this.rebuilder = rebuilder;
  }

  get buildType(): BuildType {
    return this.rebuilder.debug ? BuildType.Debug : BuildType.Release;
  }

  get metaPath(): string {
    return path.resolve(this.modulePath, 'build', this.buildType, '.forge-meta');
  }

  get metaData(): string {
    return `${this.rebuilder.arch}--${this.rebuilder.ABI}`;
  }

  get moduleName(): string {
    return path.basename(this.modulePath);
  }

  async alreadyBuiltByRebuild(): Promise<boolean> {
    if (await fs.pathExists(this.metaPath)) {
      const meta = await fs.readFile(this.metaPath, 'utf8');
      return meta === this.metaData;
    }

    return false;
  }

  async buildNodeGypArgs(prefixedArgs: string[]): Promise<string[]> {
    const args = [
      'node',
      'node-gyp',
      'rebuild',
      ...prefixedArgs,
      `--runtime=electron`,
      `--target=${this.rebuilder.electronVersion}`,
      `--arch=${this.rebuilder.arch}`,
      `--dist-url=${this.rebuilder.headerURL}`,
      '--build-from-source'
    ];

    if (process.env.DEBUG) {
      args.push('--verbose');
    }

    if (this.rebuilder.debug) {
      args.push('--debug');
    }

    args.push(...(await this.buildNodeGypArgsFromBinaryField()));

    if (this.rebuilder.msvsVersion) {
      args.push(`--msvs_version=${this.rebuilder.msvsVersion}`);
    }

    return args;
  }

  async getSupportedNapiVersions(): Promise<number[] | undefined> {
    const binary = (await this.packageJSONFieldWithDefault(
      'binary',
      {}
    )) as Record<string, number[]>;

    if ('napi_versions' in binary) {
      return binary.napi_versions;
    }

    return undefined;
  }

  async getNapiVersion(): Promise<number | undefined> {
    const moduleNapiVersions = await this.getSupportedNapiVersions();

    if (!moduleNapiVersions) {
      // This is not a Node-API module
      return undefined;
    }

    const electronNapiVersion = napiVersionFromElectronVersion(this.rebuilder.electronVersion);
    
    if (!electronNapiVersion) {
      throw new Error(`Native module '${this.moduleName}' requires Node-API but Electron v${this.rebuilder.electronVersion} does not support Node-API`);
    }

    // Filter out Node-API versions that are too high
    const filteredVersions = moduleNapiVersions.filter((v) => v <= electronNapiVersion);
    
    if (filteredVersions.length === 0) {
      throw new Error(`Native module '${this.moduleName}' supports Node-API versions ${moduleNapiVersions} but Electron v${this.rebuilder.electronVersion} only supports Node-API v${electronNapiVersion}`)
    }

    if (filteredVersions.length === 1) {
      return filteredVersions[0];
    }

    return Math.max(...filteredVersions);
  }

  async buildNodeGypArgsFromBinaryField(): Promise<string[]> {
    const binary = await this.packageJSONFieldWithDefault('binary', {}) as Record<string, string>;
    const flags = await Promise.all(Object.entries(binary).map(async ([binaryKey, binaryValue]) => {
      if (binaryKey === 'napi_versions') {
        return;
      }

      let value = binaryValue

      if (binaryKey === 'module_path') {
        value = path.resolve(this.modulePath, value);
      }

      value = value.replace('{configuration}', this.buildType)
        .replace('{node_abi}', `electron-v${this.rebuilder.electronVersion.split('.').slice(0, 2).join('.')}`)
        .replace('{platform}', process.platform)
        .replace('{arch}', this.rebuilder.arch)
        .replace('{version}', await this.packageJSONField('version') as string)
        .replace('{libc}', detectLibc.family || 'unknown');

      for (const [replaceKey, replaceValue] of Object.entries(binary)) {
        value = value.replace(`{${replaceKey}}`, replaceValue);
      }

      return `--${binaryKey}=${value}`;
    }))

    return flags.filter(value => value) as string[];
  }

  async cacheModuleState(cacheKey: string): Promise<void> {
    if (this.rebuilder.useCache) {
      await cacheModuleState(this.modulePath, this.rebuilder.cachePath, cacheKey);
    }
  }

  async isPrebuildNativeModule(): Promise<boolean> {
    const dependencies = await this.packageJSONFieldWithDefault('dependencies', {});
    return !!dependencies['prebuild-install']
  }

  async packageJSONFieldWithDefault(key: string, defaultValue: PackageJSONValue): Promise<PackageJSONValue> {
    const result = await this.packageJSONField(key);
    return result === undefined ? defaultValue : result;
  }

  async packageJSONField(key: string): Promise<PackageJSONValue | undefined> {
    this.packageJSON ||= await readPackageJson(this.modulePath);

    return this.packageJSON[key];
  }

  /**
   * Whether a prebuild-based native module exists.
   */
  async prebuildNativeModuleExists(): Promise<boolean> {
    return fs.pathExists(path.resolve(this.modulePath, 'prebuilds', `${process.platform}-${this.rebuilder.arch}`, `electron-${this.rebuilder.ABI}.node`))
  }

  private restoreEnv(env: Record<string, string | undefined>): void {
    const gotKeys = new Set<string>(Object.keys(process.env));
    const expectedKeys = new Set<string>(Object.keys(env));

    for (const key of Object.keys(process.env)) {
      if (!expectedKeys.has(key)) {
        delete process.env[key];
      } else if (env[key] !== process.env[key]) {
        process.env[key] = env[key];
      }
    }
    for (const key of Object.keys(env)) {
      if (!gotKeys.has(key)) {
        process.env[key] = env[key];
      }
    }
  }

  async rebuildNodeGypModule(cacheKey: string): Promise<void> {
    if (this.modulePath.includes(' ')) {
      console.error('Attempting to build a module with a space in the path');
      console.error('See https://github.com/nodejs/node-gyp/issues/65#issuecomment-368820565 for reasons why this may not work');
      // FIXME: Re-enable the throw when more research has been done
      // throw new Error(`node-gyp does not support building modules with spaces in their path, tried to build: ${modulePath}`);
    }

    let env: Record<string, string | undefined>;
    const extraNodeGypArgs: string[] = [];

    if (this.rebuilder.useElectronClang) {
      env = { ...process.env };
      const { env: clangEnv, args: clangArgs } = await getClangEnvironmentVars(this.rebuilder.electronVersion, this.rebuilder.arch);
      Object.assign(process.env, clangEnv);
      extraNodeGypArgs.push(...clangArgs);
    }

    const nodeGypArgs = await this.buildNodeGypArgs(extraNodeGypArgs);
    d('rebuilding', this.moduleName, 'with args', nodeGypArgs);

    const nodeGyp = NodeGyp();
    nodeGyp.parseArgv(nodeGypArgs);
    nodeGyp.devDir = ELECTRON_GYP_DIR;
    let command = nodeGyp.todo.shift();
    const originalWorkingDir = process.cwd();
    try {
      process.chdir(this.modulePath);
      while (command) {
        if (command.name === 'configure') {
          command.args = command.args.filter((arg: string) => !extraNodeGypArgs.includes(arg));
        } else if (command.name === 'build' && process.platform === 'win32') {
          // This is disgusting but it prevents node-gyp from destroying our MSBuild arguments
          command.args.map = (fn: (arg: string) => string) => {
            return Array.prototype.map.call(command.args, (arg: string) => {
              if (arg.startsWith('/p:')) return arg;
              return fn(arg);
            });
          }
        }
        await promisify(nodeGyp.commands[command.name])(command.args);
        command = nodeGyp.todo.shift();
      }
    } catch (err) {
      let errorMessage = `node-gyp failed to rebuild '${this.modulePath}'.\n`;
      errorMessage += `Error: ${err.message || err}\n\n`;
      throw new Error(errorMessage);
    } finally {
      process.chdir(originalWorkingDir);
    }

    d('built:', this.moduleName);
    await this.writeMetadata();
    await this.replaceExistingNativeModule();
    await this.cacheModuleState(cacheKey);

    if (this.rebuilder.useElectronClang) {
      this.restoreEnv(env!);
    }
  }

  async rebuildPrebuildModule(cacheKey: string): Promise<boolean> {
    if (!(await this.isPrebuildNativeModule())) {
      return false;
    }

    d(`assuming is prebuild powered: ${this.moduleName}`);
    const prebuildInstallPath = await locatePrebuild(this.modulePath);
    if (prebuildInstallPath) {
      d(`triggering prebuild download step: ${this.moduleName}`);
      let success = false;
      try {
        await this.runPrebuildInstall(prebuildInstallPath);
        success = true;
      } catch (err) {
        d('failed to use prebuild-install:', err);
      }
      if (success) {
        d('built:', this.moduleName);
        await this.writeMetadata();
        await this.cacheModuleState(cacheKey);
        return true;
      }
    } else {
      d(`could not find prebuild-install relative to: ${this.modulePath}`);
    }

    return false;
  }

  async replaceExistingNativeModule(): Promise<void> {
    const buildLocation = path.resolve(this.modulePath, 'build', this.buildType);

    d('searching for .node file', buildLocation);
    const buildLocationFiles = await fs.readdir(buildLocation);
    d('testing files', buildLocationFiles);

    const nodeFile = buildLocationFiles.find((file) => file !== '.node' && file.endsWith('.node'));
    const nodePath = nodeFile ? path.resolve(buildLocation, nodeFile) : undefined;

    if (nodePath && await fs.pathExists(nodePath)) {
      d('found .node file', nodePath);
      if (!this.rebuilder.disablePreGypCopy) {
        const abiPath = path.resolve(this.modulePath, `bin/${process.platform}-${this.rebuilder.arch}-${this.rebuilder.ABI}`);
        d('copying to prebuilt place:', abiPath);
        await fs.ensureDir(abiPath);
        await fs.copy(nodePath, path.resolve(abiPath, `${this.moduleName}.node`));
      }
    }
  }

  async runPrebuildInstall(prebuildInstallPath: string): Promise<void> {
    const shimExt = process.env.ELECTRON_REBUILD_TESTS ? 'ts' : 'js';
    const executable = process.env.ELECTRON_REBUILD_TESTS ? path.resolve(__dirname, '..', 'node_modules', '.bin', 'ts-node') : process.execPath;

    const napiVersion = await this.getNapiVersion();
    const args = napiVersion
      ? [
        '--runtime=napi',
        `--target=${napiVersion}`,
      ]
      : [
        '--runtime=electron',
        `--target=${this.rebuilder.electronVersion}`,
      ];

    await spawn(
      executable,
      [
        path.resolve(__dirname, `prebuild-shim.${shimExt}`),
        prebuildInstallPath,
        `--arch=${this.rebuilder.arch}`,
        `--platform=${process.platform}`,
        `--tag-prefix=${this.rebuilder.prebuildTagPrefix}`,
        ...args,
      ],
      {
        cwd: this.modulePath,
      }
    );
  }

  async writeMetadata(): Promise<void> {
    await fs.ensureDir(path.dirname(this.metaPath));
    await fs.writeFile(this.metaPath, this.metaData);
  }
}
