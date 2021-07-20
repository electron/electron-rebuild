import * as crypto from 'crypto';
import * as debug from 'debug';
import { EventEmitter } from 'events';
import * as fs from 'fs-extra';
import * as nodeAbi from 'node-abi';
import * as os from 'os';
import * as path from 'path';

import { readPackageJson } from './read-package-json';
import { lookupModuleState } from './cache';
import { searchForModule, searchForNodeModules } from './search-module';

export type ModuleType = 'prod' | 'dev' | 'optional';
export type RebuildMode = 'sequential' | 'parallel';

export interface RebuildOptions {
  buildPath: string;
  electronVersion: string;
  arch?: string;
  extraModules?: string[];
  onlyModules?: string[] | null;
  force?: boolean;
  headerURL?: string;
  types?: ModuleType[];
  mode?: RebuildMode;
  debug?: boolean;
  useCache?: boolean;
  useElectronClang?: boolean;
  cachePath?: string;
  prebuildTagPrefix?: string;
  projectRootPath?: string;
  forceABI?: number;
  disablePreGypCopy?: boolean;
}

export type HashTree = { [path: string]: string | HashTree };

export interface RebuilderOptions extends RebuildOptions {
  lifecycle: EventEmitter;
}

const d = debug('electron-rebuild');

const defaultMode: RebuildMode = 'sequential';
const defaultTypes: ModuleType[] = ['prod', 'optional'];
// Update this number if you change the caching logic to ensure no bad cache hits
const ELECTRON_REBUILD_CACHE_ID = 1;

export class Rebuilder {
  private ABIVersion: string | undefined;
  nodeGypPath: string;
  prodDeps: Set<string>;
  rebuilds: (() => Promise<void>)[];
  realModulePaths: Set<string>;
  realNodeModulesPaths: Set<string>;

  public lifecycle: EventEmitter;
  public buildPath: string;
  public electronVersion: string;
  public arch: string;
  public extraModules: string[];
  public onlyModules: string[] | null;
  public force: boolean;
  public headerURL: string;
  public types: ModuleType[];
  public mode: RebuildMode;
  public debug: boolean;
  public useCache: boolean;
  public cachePath: string;
  public prebuildTagPrefix: string;
  public projectRootPath?: string;
  public msvsVersion?: string;
  public useElectronClang: boolean;
  public disablePreGypCopy: boolean;

  constructor(options: RebuilderOptions) {
    this.lifecycle = options.lifecycle;
    this.buildPath = options.buildPath;
    this.electronVersion = options.electronVersion;
    this.arch = options.arch || process.arch;
    this.extraModules = options.extraModules || [];
    this.onlyModules = options.onlyModules || null;
    this.force = options.force || false;
    this.headerURL = options.headerURL || 'https://www.electronjs.org/headers';
    this.types = options.types || defaultTypes;
    this.mode = options.mode || defaultMode;
    this.debug = options.debug || false;
    this.useCache = options.useCache || false;
    this.useElectronClang = options.useElectronClang || false;
    this.cachePath = options.cachePath || path.resolve(os.homedir(), '.electron-rebuild-cache');
    this.prebuildTagPrefix = (options.prebuildTagPrefix !== undefined) ? options.prebuildTagPrefix : 'v';
    this.msvsVersion = process.env.GYP_MSVS_VERSION;
    this.disablePreGypCopy = options.disablePreGypCopy || false;

    if (this.useCache && this.force) {
      console.warn('[WARNING]: Electron Rebuild has force enabled and cache enabled, force take precedence and the cache will not be used.');
      this.useCache = false;
    }
    this.projectRootPath = options.projectRootPath;

    if (typeof this.electronVersion === 'number') {
      if (`${this.electronVersion}`.split('.').length === 1) {
        this.electronVersion = `${this.electronVersion}.0.0`;
      } else {
        this.electronVersion = `${this.electronVersion}.0`;
      }
    }
    if (typeof this.electronVersion !== 'string') {
      throw new Error(`Expected a string version for electron version, got a "${typeof this.electronVersion}"`);
    }

    this.ABIVersion = options.forceABI?.toString();
    this.prodDeps = this.extraModules.reduce((acc: Set<string>, x: string) => acc.add(x), new Set<string>());
    this.rebuilds = [];
    this.realModulePaths = new Set();
    this.realNodeModulesPaths = new Set();
  }

  get ABI(): string {
    if (this.ABIVersion === undefined) {
      this.ABIVersion = nodeAbi.getAbi(this.electronVersion, 'electron');
    }

    return this.ABIVersion!;
  }

  async rebuild(): Promise<void> {
    if (!path.isAbsolute(this.buildPath)) {
      throw new Error('Expected buildPath to be an absolute path');
    }
    d(
      'rebuilding with args:',
      this.buildPath,
      this.electronVersion,
      this.arch,
      this.extraModules,
      this.force,
      this.headerURL,
      this.types,
      this.debug
    );

    this.lifecycle.emit('start');

    const rootPackageJson = await readPackageJson(this.buildPath);
    const markWaiters: Promise<void>[] = [];
    const depKeys = [];

    if (this.types.indexOf('prod') !== -1 || this.onlyModules) {
      depKeys.push(...Object.keys(rootPackageJson.dependencies || {}));
    }
    if (this.types.indexOf('optional') !== -1 || this.onlyModules) {
      depKeys.push(...Object.keys(rootPackageJson.optionalDependencies || {}));
    }
    if (this.types.indexOf('dev') !== -1 || this.onlyModules) {
      depKeys.push(...Object.keys(rootPackageJson.devDependencies || {}));
    }

    for (const key of depKeys) {
      this.prodDeps[key] = true;
      const modulePaths: string[] = await searchForModule(
        this.buildPath,
        key,
        this.projectRootPath
      );
      for (const modulePath of modulePaths) {
        markWaiters.push(this.markChildrenAsProdDeps(modulePath));
      }
    }

    await Promise.all(markWaiters);

    d('identified prod deps:', this.prodDeps);

    const nodeModulesPaths = await searchForNodeModules(
      this.buildPath,
      this.projectRootPath
    );
    for (const nodeModulesPath of nodeModulesPaths) {
      await this.rebuildAllModulesIn(nodeModulesPath);
    }

    this.rebuilds.push(() => this.rebuildModuleAt(this.buildPath));

    if (this.mode !== 'sequential') {
      await Promise.all(this.rebuilds.map(fn => fn()));
    } else {
      for (const rebuildFn of this.rebuilds) {
        await rebuildFn();
      }
    }
  }

  private hashDirectory = async (dir: string, relativeTo = dir): Promise<HashTree> => {
    d('hashing dir', dir);
    const dirTree: HashTree = {};
    await Promise.all((await fs.readdir(dir)).map(async (child) => {
      d('found child', child, 'in dir', dir);
      // Ignore output directories
      if (dir === relativeTo && (child === 'build' || child === 'bin')) return;
      // Don't hash nested node_modules
      if (child === 'node_modules') return;

      const childPath = path.resolve(dir, child);
      const relative = path.relative(relativeTo, childPath);
      if ((await fs.stat(childPath)).isDirectory()) {
        dirTree[relative] = await this.hashDirectory(childPath, relativeTo);
      } else {
        dirTree[relative] = crypto.createHash('SHA256').update(await fs.readFile(childPath)).digest('hex');
      }
    }));
    return dirTree;
  }

  private dHashTree = (tree: HashTree, hash: crypto.Hash): void => {
    for (const key of Object.keys(tree).sort()) {
      hash.update(key);
      if (typeof tree[key] === 'string') {
        hash.update(tree[key] as string);
      } else {
        this.dHashTree(tree[key] as HashTree, hash);
      }
    }
  }

  private generateCacheKey = async (opts: { modulePath: string }): Promise<string> => {
    const tree = await this.hashDirectory(opts.modulePath);
    const hasher = crypto.createHash('SHA256')
      .update(`${ELECTRON_REBUILD_CACHE_ID}`)
      .update(path.basename(opts.modulePath))
      .update(this.ABI)
      .update(this.arch)
      .update(this.debug ? 'debug' : 'not debug')
      .update(this.headerURL)
      .update(this.electronVersion);
    this.dHashTree(tree, hasher);
    const hash = hasher.digest('hex');
    d('calculated hash of', opts.modulePath, 'to be', hash);
    return hash;
  }

  async rebuildModuleAt(modulePath: string): Promise<void> {
    if (!(await fs.pathExists(path.resolve(modulePath, 'binding.gyp')))) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ModuleRebuilder } = require('./module-rebuilder');
    const moduleRebuilder = new ModuleRebuilder(this, modulePath);

    this.lifecycle.emit('module-found', path.basename(modulePath));

    if (!this.force && await moduleRebuilder.alreadyBuiltByRebuild()) {
      d(`skipping: ${path.basename(modulePath)} as it is already built`);
      this.lifecycle.emit('module-done');
      this.lifecycle.emit('module-skip');
      return;
    }

    if (await moduleRebuilder.prebuildNativeModuleExists(modulePath)) {
      d(`skipping: ${path.basename(modulePath)} as it was prebuilt`);
      return;
    }

    let cacheKey!: string;
    if (this.useCache) {
      cacheKey = await this.generateCacheKey({
        modulePath,
      });

      const applyDiffFn = await lookupModuleState(this.cachePath, cacheKey);
      if (typeof applyDiffFn === 'function') {
        await applyDiffFn(modulePath);
        this.lifecycle.emit('module-done');
        return;
      }
    }

    if (await moduleRebuilder.rebuildPrebuildModule(cacheKey)) {
      this.lifecycle.emit('module-done');
      return;
    }
    await moduleRebuilder.rebuildNodeGypModule(cacheKey);
    this.lifecycle.emit('module-done');
  }

  async rebuildAllModulesIn(nodeModulesPath: string, prefix = ''): Promise<void> {
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
      // Ignore the magical .bin directory
      if (modulePath === '.bin') continue;
      // Ensure that we don't mark modules as needing to be rebuilt more than once
      // by ignoring / resolving symlinks
      const realPath = await fs.realpath(path.resolve(nodeModulesPath, modulePath));

      if (this.realModulePaths.has(realPath)) {
        continue;
      }
      this.realModulePaths.add(realPath);

      if (this.prodDeps[`${prefix}${modulePath}`] && (!this.onlyModules || this.onlyModules.includes(modulePath))) {
        this.rebuilds.push(() => this.rebuildModuleAt(realPath));
      }

      if (modulePath.startsWith('@')) {
        await this.rebuildAllModulesIn(realPath, `${modulePath}/`);
      }

      if (await fs.pathExists(path.resolve(nodeModulesPath, modulePath, 'node_modules'))) {
        await this.rebuildAllModulesIn(path.resolve(realPath, 'node_modules'));
      }
    }
  }

  async findModule(moduleName: string, fromDir: string, foundFn: ((p: string) => Promise<void>)): Promise<void[]> {

    const testPaths = await searchForModule(
      fromDir,
      moduleName,
      this.projectRootPath
    );
    const foundFns = testPaths.map(testPath => foundFn(testPath));

    return Promise.all(foundFns);
  }

  async markChildrenAsProdDeps(modulePath: string): Promise<void> {
    if (!await fs.pathExists(modulePath)) {
      return;
    }

    d('exploring', modulePath);
    let childPackageJson;
    try {
      childPackageJson = await readPackageJson(modulePath, true);
    } catch (err) {
      return;
    }
    const moduleWait: Promise<void[]>[] = [];

    const callback = this.markChildrenAsProdDeps.bind(this);
    for (const key of Object.keys(childPackageJson.dependencies || {}).concat(Object.keys(childPackageJson.optionalDependencies || {}))) {
      if (this.prodDeps[key]) {
        continue;
      }

      this.prodDeps[key] = true;

      moduleWait.push(this.findModule(key, modulePath, callback));
    }

    await Promise.all(moduleWait);
  }
}

function rebuildWithOptions(options: RebuildOptions): Promise<void> {
  // eslint-disable-next-line prefer-rest-params
  d('rebuilding with args:', arguments);
  const lifecycle = new EventEmitter();
  const rebuilderOptions: RebuilderOptions = { ...options, lifecycle };
  const rebuilder = new Rebuilder(rebuilderOptions);

  const ret = rebuilder.rebuild() as Promise<void> & { lifecycle: EventEmitter };
  ret.lifecycle = lifecycle;

  return ret;
}

export type RebuilderResult = Promise<void> & { lifecycle: EventEmitter };
export type RebuildFunctionWithOptions = (options: RebuildOptions) => RebuilderResult;
export type RebuildFunctionWithArgs = (
  buildPath: string,
  electronVersion: string,
  arch?: string,
  extraModules?: string[],
  force?: boolean,
  headerURL?: string,
  types?: ModuleType[],
  mode?: RebuildMode,
  onlyModules?: string[] | null,
  debug?: boolean
) => RebuilderResult;
export type RebuildFunction = RebuildFunctionWithArgs & RebuildFunctionWithOptions;

export function createOptions(
    buildPath: string,
    electronVersion: string,
    arch: string,
    extraModules: string[],
    force: boolean,
    headerURL: string,
    types: ModuleType[],
    mode: RebuildMode,
    onlyModules: string[] | null,
    debug: boolean ): RebuildOptions {

  return {
    buildPath,
    electronVersion,
    arch,
    extraModules,
    onlyModules,
    force,
    headerURL,
    types,
    mode,
    debug
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doRebuild(options: any, ...args: any[]): Promise<void> {
  if (typeof options === 'object') {
    return rebuildWithOptions(options as RebuildOptions);
  }
  console.warn('You are using the deprecated electron-rebuild API, please switch to using the options object instead');
  // eslint-disable-next-line @typescript-eslint/ban-types
  return rebuildWithOptions((createOptions as Function)(options, ...args));
}

export const rebuild = (doRebuild as RebuildFunction);

export function rebuildNativeModules(
    electronVersion: string,
    modulePath: string,
    whichModule= '',
    _headersDir: string | null = null,
    arch= process.arch,
    _command: string,
    _ignoreDevDeps= false,
    _ignoreOptDeps= false,
    _verbose= false): Promise<void> {
  if (path.basename(modulePath) === 'node_modules') {
    modulePath = path.dirname(modulePath);
  }

  d('rebuilding in:', modulePath);
  console.warn('You are using the old API, please read the new docs and update to the new API');

  return rebuild(modulePath, electronVersion, arch, whichModule.split(','));
}
