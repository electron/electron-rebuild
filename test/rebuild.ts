import { expect } from 'chai';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from '@malept/cross-spawn-promise';

import { determineChecksum } from './helpers/checksum';
import { expectNativeModuleToBeRebuilt, expectNativeModuleToNotBeRebuilt } from './helpers/rebuild';
import { getExactElectronVersionSync } from './helpers/electron-version';
import { rebuild, RebuildOptions } from '../src/rebuild';

const MINUTES_IN_MILLISECONDS = 60 * 1000;
const testElectronVersion = getExactElectronVersionSync();

describe('rebuilder', () => {
  const testModulePath = path.resolve(os.tmpdir(), 'electron-rebuild-test');
  const timeoutMinutes = process.platform === 'win32' ? 5 : 2;
  const msvs_version: string | undefined = process.env.GYP_MSVS_VERSION;

  const resetMSVSVersion = () => {
    if (msvs_version) {
      process.env.GYP_MSVS_VERSION = msvs_version;
    }
  };
  const resetTestModule = async (): Promise<void> => {
    await fs.remove(testModulePath);
    await fs.mkdirs(testModulePath);
    await fs.copy(
      path.resolve(__dirname, '../test/fixture/native-app1/package.json'),
      path.resolve(testModulePath, 'package.json')
    );
    await spawn('npm', ['install'], { cwd: testModulePath });
    resetMSVSVersion();
  };

  const cleanupTestModule = async (): Promise<void> => {
    await fs.remove(testModulePath);
    resetMSVSVersion();
  }

  const optionSets: {
    name: string;
    args: RebuildOptions | string[];
  }[] = [
    { args: [testModulePath, testElectronVersion, process.arch], name: 'sequential args' },
    { args: {
      buildPath: testModulePath,
      electronVersion: testElectronVersion,
      arch: process.arch
    }, name: 'options object' }
  ];
  for (const options of optionSets) {
    describe(`core behavior -- ${options.name}`, function() {
      this.timeout(timeoutMinutes * MINUTES_IN_MILLISECONDS);

      before(async () => {
        await resetTestModule();

        let args: RebuildOptions | string | string[] = options.args;
        if (!Array.isArray(args) && typeof args === 'string') {
          args = [args];
        }
        process.env.ELECTRON_REBUILD_TESTS = 'true';
        if (Array.isArray(args)) {
          // eslint-disable-next-line @typescript-eslint/ban-types
          await (rebuild as Function)(...(args as string[]));
        } else {
          await rebuild(args);
        }
      });

      it('should have rebuilt top level prod dependencies', async () => {
        await expectNativeModuleToBeRebuilt(testModulePath, 'ref-napi');
      });

      it('should have rebuilt top level prod dependencies that are using prebuild', async () => {
        await expectNativeModuleToBeRebuilt(testModulePath, 'farmhash');
      });

      it('should have rebuilt children of top level prod dependencies', async () => {
        await expectNativeModuleToBeRebuilt(testModulePath, 'leveldown');
      });

      it('should have rebuilt children of scoped top level prod dependencies', async () => {
        await expectNativeModuleToBeRebuilt(testModulePath, '@newrelic/native-metrics');
      });

      it('should have rebuilt top level optional dependencies', async () => {
        await expectNativeModuleToBeRebuilt(testModulePath, 'bcrypt');
      });

      it('should not have rebuilt top level devDependencies', async () => {
        await expectNativeModuleToNotBeRebuilt(testModulePath, 'ffi-napi');
      });

      it('should not download files in the module directory', async () => {
        const modulePath = path.resolve(testModulePath, 'node_modules/ref-napi');
        const fileNames = await fs.readdir(modulePath);

        expect(fileNames).to.not.contain(testElectronVersion);
      });

      after(async () => {
        delete process.env.ELECTRON_REBUILD_TESTS;
        await cleanupTestModule();
      });
    });
  }

  describe('force rebuild', function() {
    this.timeout(timeoutMinutes * MINUTES_IN_MILLISECONDS);

    before(resetTestModule);
    after(cleanupTestModule);
    afterEach(resetMSVSVersion);

    it('should skip the rebuild step when disabled', async () => {
      await rebuild(testModulePath, testElectronVersion, process.arch);
      resetMSVSVersion();
      const rebuilder = rebuild(testModulePath, testElectronVersion, process.arch, [], false);
      let skipped = 0;
      rebuilder.lifecycle.on('module-skip', () => {
        skipped++;
      });
      await rebuilder;
      expect(skipped).to.equal(5);
    });

    it('should rebuild all modules again when disabled but the electron ABI bumped', async () => {
      await rebuild(testModulePath, testElectronVersion, process.arch);
      resetMSVSVersion();
      const rebuilder = rebuild(testModulePath, '3.0.0', process.arch, [], false);
      let skipped = 0;
      rebuilder.lifecycle.on('module-skip', () => {
        skipped++;
      });
      await rebuilder;
      expect(skipped).to.equal(0);
    });

    it('should rebuild all modules again when enabled', async function() {
      if (process.platform === 'darwin') {
        this.timeout(5 * MINUTES_IN_MILLISECONDS);
      }
      await rebuild(testModulePath, testElectronVersion, process.arch);
      resetMSVSVersion();
      const rebuilder = rebuild(testModulePath, testElectronVersion, process.arch, [], true);
      let skipped = 0;
      rebuilder.lifecycle.on('module-skip', () => {
        skipped++;
      });
      await rebuilder;
      expect(skipped).to.equal(0);
    });
  });

  describe('only rebuild', function() {
    this.timeout(2 * MINUTES_IN_MILLISECONDS);

    beforeEach(resetTestModule);
    afterEach(cleanupTestModule);

    it('should rebuild only specified modules', async () => {
      const nativeModuleBinary = path.join(testModulePath, 'node_modules', 'farmhash', 'build', 'Release', 'farmhash.node');
      const nodeModuleChecksum = await determineChecksum(nativeModuleBinary);
      const rebuilder = rebuild({
        buildPath: testModulePath,
        electronVersion: testElectronVersion,
        arch: process.arch,
        onlyModules: ['farmhash'],
        force: true
      });
      let built = 0;
      rebuilder.lifecycle.on('module-done', () => built++);
      await rebuilder;
      expect(built).to.equal(1);
      const electronModuleChecksum = await determineChecksum(nativeModuleBinary);
      expect(electronModuleChecksum).to.not.equal(nodeModuleChecksum);
    });

    it('should rebuild only specified modules with prefixes', async () => {
      const rebuilder = rebuild({
        buildPath: testModulePath,
        electronVersion: '5.0.13',
        arch: process.arch,
        onlyModules: ['@nlv8/signun'],
        force: true
      });
      let built = 0;
      rebuilder.lifecycle.on('module-done', () => built++);
      await rebuilder;
      expect(built).to.equal(1);
    });

    it('should rebuild only specified modules missing prefixes', async () => {
      const rebuilder = rebuild({
        buildPath: testModulePath,
        electronVersion: '5.0.13',
        arch: process.arch,
        onlyModules: ['signun'],
        force: true
      });
      let built = 0;
      rebuilder.lifecycle.on('module-done', () => built++);
      await rebuilder;
      expect(built).to.equal(1);
    });

    it('should rebuild multiple specified modules via --only option', async () => {
      const rebuilder = rebuild({
        buildPath: testModulePath,
        electronVersion: testElectronVersion,
        arch: process.arch,
        onlyModules: ['ffi-napi', 'ref-napi'], // TODO: check to see if there's a bug with scoped modules
        force: true
      });
      let built = 0;
      rebuilder.lifecycle.on('module-done', () => built++);
      await rebuilder;
      expect(built).to.equal(2);
    });
  });

  describe('debug rebuild', function() {
    this.timeout(10 * MINUTES_IN_MILLISECONDS);

    before(resetTestModule);
    after(cleanupTestModule);

    it('should have rebuilt ffi-napi module in Debug mode', async () => {
      await rebuild({
        buildPath: testModulePath,
        electronVersion: testElectronVersion,
        arch: process.arch,
        onlyModules: ['ffi-napi'],
        force: true,
        debug: true
      });
      await expectNativeModuleToBeRebuilt(testModulePath, 'ffi-napi', { buildType: 'Debug' });
      await expectNativeModuleToNotBeRebuilt(testModulePath, 'ffi-napi');
    });
  });

  describe('useElectronClang rebuild', function() {
    this.timeout(10 * MINUTES_IN_MILLISECONDS);

    before(resetTestModule);
    after(cleanupTestModule);

    it('should have rebuilt ffi-napi module using clang mode', async () => {
      await rebuild({
        buildPath: testModulePath,
        electronVersion: testElectronVersion,
        arch: process.arch,
        onlyModules: ['ffi-napi'],
        force: true,
        useElectronClang: true
      });
      await expectNativeModuleToBeRebuilt(testModulePath, 'ffi-napi');
    });
  });
});
