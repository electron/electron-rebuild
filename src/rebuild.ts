import { spawnPromise } from 'spawn-rx';
import * as debug from 'debug';
import * as EventEmitter from 'events';
import * as fs from 'fs-extra';
import * as nodeAbi from 'node-abi';
import * as os from 'os';
import * as path from 'path';
import { readPackageJson } from './read-package-json';
import {isNullOrUndefined} from 'util';

const d = debug('electron-rebuild');

const defaultMode = process.platform === 'win32' ? 'sequential' : 'parallel';

const locateGypModule = async(cli: string) => {
  let testPath = __dirname;
  for (let upDir = 0; upDir <= 20; upDir++) {
    const nodeGypTestPath = path.resolve(testPath, `node_modules/.bin/${cli}${process.platform === 'win32' ? '.cmd' : ''}`);
    if (await fs.exists(nodeGypTestPath)) {
      return nodeGypTestPath;
    }
    testPath = path.resolve(testPath, '..');
  }
  return null;
};

const locateNodeGyp = async () => {
  return await locateGypModule('node-gyp');
};

const locateNodePreGyp = async () => {
  return await locateGypModule('node-pre-gyp');
};

class Rebuilder {
  ABI: string;
  nodeGypPath: string;
  prodDeps: Set<string>;
  rebuilds: (() => Promise<void>)[];
  realModulePaths: Set<string>;
  realNodeModulesPaths: Set<string>;

  constructor(
      public lifecycle: EventEmitter,
      public buildPath: string,
      public electronVersion: string,
      public arch = process.arch,
      public extraModules: string[] = [],
      public forceRebuild = false,
      public headerURL = 'https://atom.io/download/electron',
      public types = ['prod', 'optional'],
      public mode = defaultMode) {
    this.ABI = nodeAbi.getAbi(electronVersion, 'electron');
    this.prodDeps = extraModules.reduce((acc, x) => acc.add(x), new Set());
    this.rebuilds = [];
    this.realModulePaths = new Set();
    this.realNodeModulesPaths = new Set();
  }

  async rebuild() {
    if (!path.isAbsolute(this.buildPath)) {
      throw new Error('Expected buildPath to be an absolute path');
    }
    d('rebuilding with args:', this.buildPath, this.electronVersion, this.arch, this.extraModules, this.forceRebuild, this.headerURL, this.types);

    this.lifecycle.emit('start');

    const rootPackageJson = await readPackageJson(this.buildPath);
    const markWaiters: Promise<void>[] = [];
    const depKeys = [];

    if (this.types.indexOf('prod') !== -1) {
      depKeys.push(...Object.keys(rootPackageJson.dependencies || {}));
    }
    if (this.types.indexOf('optional') !== -1) {
      depKeys.push(...Object.keys(rootPackageJson.optionalDependencies || {}));
    }
    if (this.types.indexOf('dev') !== -1) {
      depKeys.push(...Object.keys(rootPackageJson.devDependencies || {}));
    }

    depKeys.forEach((key) => {
      this.prodDeps[key] = true;
      markWaiters.push(this.markChildrenAsProdDeps(path.resolve(this.buildPath, 'node_modules', key)));
    });

    await Promise.all(markWaiters);

    d('identified prod deps:', this.prodDeps);

    await this.rebuildAllModulesIn(path.resolve(this.buildPath, 'node_modules'));
    this.rebuilds.push(() => this.rebuildModuleAt(this.buildPath));

    if (this.mode !== 'sequential') {
      await Promise.all(this.rebuilds.map(fn => fn()));
    } else {
      for (const rebuildFn of this.rebuilds) {
        await rebuildFn();
      }
    }
  }

  async rebuildModuleAt(modulePath: string) {
    if (!(await fs.exists(path.resolve(modulePath, 'binding.gyp')))) {
      return;
    }

    const nodeGypPath = await locateNodeGyp();
    const nodePreGypPath = await locateNodePreGyp();
    if (!nodeGypPath || !nodePreGypPath) {
      throw new Error('Could not locate node-gyp or node-pre-gyp');
    }

    const metaPath = path.resolve(modulePath, 'build', 'Release', '.forge-meta');
    const metaData = `${this.arch}--${this.ABI}`;

    this.lifecycle.emit('module-found', path.basename(modulePath));

    if (!this.forceRebuild && await fs.exists(metaPath)) {
      const meta = await fs.readFile(metaPath, 'utf8');
      if (meta === metaData) {
        d(`skipping: ${path.basename(modulePath)} as it is already built`);
        this.lifecycle.emit('module-done');
        this.lifecycle.emit('module-skip');
        return;
      }
    }
    if (await fs.exists(path.resolve(modulePath, 'prebuilds', `${process.platform}-${this.arch}`, `electron-${this.ABI}.node`))) {
      d(`skipping: ${path.basename(modulePath)} as it was prebuilt`);
      return;
    }
    d('rebuilding:', path.basename(modulePath));
    const modulePackageJson = await readPackageJson(modulePath);
    const moduleName = path.basename(modulePath);
    let moduleBinaryPath = path.resolve(modulePath, 'build/Release');
    const preGypReady = !isNullOrUndefined(modulePackageJson.binary);

    const rebuildArgs = [
      preGypReady ? 'reinstall' : 'rebuild',
      `--target=${this.electronVersion}`,
      `--arch=${this.arch}`,
      `--dist-url=${this.headerURL}`,
      preGypReady ? '--fallback-to-build' : '--build-from-source',
    ];

    Object.keys(modulePackageJson.binary || {}).forEach((binaryKey) => {
      let value = modulePackageJson.binary[binaryKey];

      value = value.replace('{configuration}', 'Release')
        .replace('{node_abi}', `electron-v${this.electronVersion.split('.').slice(0, 2).join('.')}`)
        .replace('{platform}', process.platform)
        .replace('{arch}', this.arch)
        .replace('{version}', modulePackageJson.version)
        .replace('{name}', modulePackageJson.name);

      if (binaryKey === 'module_path') {
        value = path.resolve(modulePath, value);
        moduleBinaryPath = value;
      }

      Object.keys(modulePackageJson.binary).forEach((binaryReplaceKey) => {
        value = value.replace(`{${binaryReplaceKey}}`, modulePackageJson.binary[binaryReplaceKey]);
      });

      rebuildArgs.push(`--${binaryKey}=${value}`);
    });

    d('rebuilding', moduleName, 'with args', rebuildArgs);
    await spawnPromise(preGypReady ? nodePreGypPath : nodeGypPath, rebuildArgs, {
      cwd: modulePath,
      env: Object.assign({}, process.env, {
        HOME: path.resolve(os.homedir(), '.electron-gyp'),
        USERPROFILE: path.resolve(os.homedir(), '.electron-gyp'),
        npm_config_disturl: 'https://atom.io/download/electron',
        npm_config_runtime: 'electron',
        npm_config_arch: this.arch,
        npm_config_target_arch: this.arch,
        npm_config_build_from_source: !preGypReady,
      }),
    });

    d('built:', moduleName);
    if (!(await fs.exists(metaPath))) {
      await fs.mkdirs(path.dirname(metaPath));
    }
    await fs.writeFile(metaPath, metaData);

    d('searching for .node file', moduleBinaryPath);
    d('testing files', (await fs.readdir(moduleBinaryPath)));
    const nodePath = path.resolve(moduleBinaryPath,
      (await fs.readdir(moduleBinaryPath))
        .find((file) => file !== '.node' && file.endsWith('.node'))
      );

    const abiPath = path.resolve(modulePath, `bin/${process.platform}-${this.arch}-${this.ABI}`);
    if (await fs.exists(nodePath)) {
      d('found .node file', nodePath);
      d('copying to prebuilt place:', abiPath);
      if (!(await fs.exists(abiPath))) {
        await fs.mkdirs(abiPath);
      }
      await fs.copy(nodePath, path.resolve(abiPath, `${moduleName}.node`));
    }

    this.lifecycle.emit('module-done');
  }

  async rebuildAllModulesIn(nodeModulesPath: string, prefix = '') {
    // Some package managers use symbolic links when installing node modules
    // we need to be sure we've never tested the a package before by resolving
    // all symlinks in the path and testing against a set
    const realNodeModulesPath = await fs.realpath(nodeModulesPath);
    if (this.realNodeModulesPaths.has(realNodeModulesPath)) {
      return;
    }
    this.realNodeModulesPaths.add(realNodeModulesPath);

    d('scanning:', realNodeModulesPath);

    for (const modulePath of await fs.readdir(realNodeModulesPath)) {
      // Ensure that we don't mark modules as needing to be rebuilt more than once
      // by ignoring / resolving symlinks
      const realPath = await fs.realpath(path.resolve(nodeModulesPath, modulePath));

      if (this.realModulePaths.has(realPath)) {
        continue;
      }
      this.realModulePaths.add(realPath);

      if (this.prodDeps[`${prefix}${modulePath}`]) {
        this.rebuilds.push(() => this.rebuildModuleAt(realPath));
      }

      if (modulePath.startsWith('@')) {
        await this.rebuildAllModulesIn(realPath, `${modulePath}/`);
      }

      if (await fs.exists(path.resolve(nodeModulesPath, modulePath, 'node_modules'))) {
        await this.rebuildAllModulesIn(path.resolve(realPath, 'node_modules'));
      }
    }
  };

  async findModule(moduleName: string, fromDir: string, foundFn: ((p: string) => Promise<void>)) {
    let targetDir = fromDir;
    const foundFns = [];

    while (targetDir !== path.dirname(this.buildPath)) {
      const testPath = path.resolve(targetDir, 'node_modules', moduleName);
      if (await fs.exists(testPath)) {
        foundFns.push(foundFn(testPath));
      }

      targetDir = path.dirname(targetDir);
    }

    await Promise.all(foundFns);
  };

  async markChildrenAsProdDeps(modulePath: string) {
    if (!await fs.exists(modulePath)) {
      return;
    }

    d('exploring', modulePath);
    const childPackageJson = await readPackageJson(modulePath);
    const moduleWait: Promise<void>[] = [];

    const callback = this.markChildrenAsProdDeps.bind(this);
    Object.keys(childPackageJson.dependencies || {}).concat(Object.keys(childPackageJson.optionalDependencies || {})).forEach((key) => {
      if (this.prodDeps[key]) {
        return;
      }

      this.prodDeps[key] = true;

      moduleWait.push(this.findModule(key, modulePath, callback));
    });

    await Promise.all(moduleWait);
  };
}

export function rebuild(
    buildPath: string,
    electronVersion: string,
    arch = process.arch,
    extraModules: string[] = [],
    forceRebuild = false,
    headerURL = 'https://atom.io/download/electron',
    types = ['prod', 'optional'],
    mode = defaultMode) {

  d('rebuilding with args:', arguments);
  const lifecycle = new EventEmitter();
  const rebuilder = new Rebuilder(lifecycle, buildPath, electronVersion, arch, extraModules, forceRebuild, headerURL, types, mode);

  let ret = rebuilder.rebuild() as Promise<void> & { lifecycle: EventEmitter };
  ret.lifecycle = lifecycle;

  return ret;
}

export function rebuildNativeModules(
    electronVersion: string,
    modulePath: string,
    whichModule= '',
    _headersDir: string | null = null,
    arch= process.arch,
    _command: string,
    _ignoreDevDeps= false,
    _ignoreOptDeps= false,
    _verbose= false) {
  if (path.basename(modulePath) === 'node_modules') {
    modulePath = path.dirname(modulePath);
  }

  d('rebuilding in:', modulePath);
  console.warn('You are using the old API, please read the new docs and update to the new API');

  return rebuild(modulePath, electronVersion, arch, whichModule.split(','));
};
