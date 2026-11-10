import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(import.meta.url);

async function installedModule(scope, name) {
  const dir = join(scope, name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  return import(pathToFileURL(join(dir, manifest.main)).href);
}

async function checkProfile(scope, profileDir, version) {
  const boot = await installedModule(scope, 'dsh-app-boot');
  if (!version) {
    const { PROFILE_TEMPLATES } = await installedModule(scope, 'dsh-official-bundles');
    await mkdir(profileDir, { recursive: true });
    boot.initProfile(profileDir, PROFILE_TEMPLATES.web.bundles);
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nupdateNotifier: false\n');
    // The Electron shell normally supplies telemetry configuration. The smoke uses loopback only.
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      '- id: desktop-product-telemetry',
      '  disabled: true',
      '- id: product-analytics',
      '  disabled: true',
      '- id: webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '',
    ].join('\n'));
    return;
  }

  const installAnchor = join(scope, 'dsh', 'package.json');
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert(profile.layers.some((layer) => layer.packageName === 'dingtalk-dsh'), 'Desktop did not select the installed bundle');
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile });
  const cordis = resolution.entries.find((entry) => entry.name === '@deepseek-ai/cordis');
  assert.equal(cordis?.scope, 'installation');
  const { Context } = await installedModule(scope, 'cordis');
  const context = new Context();
  context.plugin(boot.PluginPackages, { resolution });
  const pluginDir = join(profileDir, 'node_modules', 'dingtalk-dsh');
  const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  const plugin = await import(pathToFileURL(join(pluginDir, manifest.main)).href);
  assert.equal(manifest.version, version);
  assert.equal(plugin.name, 'dingtalk-bridge');
  assert.equal(typeof plugin.apply, 'function');
  console.log(`Loaded dingtalk-dsh ${version} with Desktop Cordis ${cordis.version}.`);
}

async function smokeHost(executable, args, options) {
  const host = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  for (const stream of [host.stdout, host.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-8000); });
  }

  try {
    await new Promise((resolve, reject) => {
      let ready = false;
      let stopped = false;
      let fatal;
      const deadline = setTimeout(() => reject(new Error(`Desktop Host timed out.\n${output}`)), 60_000);
      host.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      host.on('message', (message) => {
        if (message?.type === 'ready' && !ready) {
          ready = true;
          host.send({ type: 'shutdown' }, (error) => { if (error) reject(error); });
        }
        if (message?.type === 'shutdown-complete') stopped = true;
        if (message?.type === 'fatal') fatal = message.message;
      });
      host.once('close', (code) => {
        clearTimeout(deadline);
        if (ready && stopped && code === 0 && !fatal) resolve();
        else reject(new Error(`Desktop Host failed readiness or shutdown (exit ${code}). ${fatal ?? ''}\n${output}`));
      });
    });
    console.log('Desktop Host reported ready and exited cleanly.');
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill();
  }
}

async function smokeDesktop(executable, archive, version) {
  const root = await realpath(tmpdir());
  const home = await mkdtemp(join(root, 'dingtalk-dsh-desktop-smoke-'));
  const profile = join(home, 'profiles', 'desktop');
  const resources = join(dirname(executable), 'resources');
  const runtime = join(resources, 'app.asar', 'dsh');
  const scope = join(runtime, 'node_modules', '@deepseek-ai');
  const support = join(resources, 'runtime');
  const primary = join(support, 'primary-runtime');
  const hostPackage = join(scope, 'dsh-desktop-host', 'lib');
  const systemKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'PROGRAMFILES', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase()))),
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: executable,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
    npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'npmrc'),
    npm_config_store_dir: join(home, 'store'), npm_config_enable_global_virtual_store: 'false',
  };
  const options = { cwd: home, env, windowsHide: true };

  try {
    await writeFile(join(home, 'npmrc'), '');
    const helper = [script, '--check-profile', scope, profile];
    await run(executable, ['--expose-internals', ...helper], { ...options, timeout: 60_000 });
    await run(executable, ['--expose-internals', join(hostPackage, 'cli.js'),
      'plugin', '--profile', 'desktop', 'add', archive], { ...options, timeout: 180_000 });
    const { stdout } = await run(executable, ['--expose-internals', ...helper, version],
      { ...options, timeout: 60_000 });
    process.stdout.write(stdout);
    await smokeHost(executable, ['--expose-internals', join(hostPackage, 'index.js'), runtime, profile, primary,
      join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), join(support, 'bin')], { ...options, cwd: profile });
  } finally {
    const target = await realpath(home);
    assert(dirname(target) === root && basename(target).startsWith('dingtalk-dsh-desktop-smoke-'));
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

const [first, second, third, fourth] = process.argv.slice(2);
if (first === '--check-profile') {
  await checkProfile(second, third, fourth);
} else {
  assert(first && second && /^\d+\.\d+\.\d+$/.test(third), 'Usage: smoke-desktop.mjs <desktop.exe> <archive.tgz> <version>');
  await smokeDesktop(resolve(first), resolve(second), third);
}
