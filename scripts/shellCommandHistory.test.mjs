import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const nativePtyAvailable = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;
if (!nativePtyAvailable) {
  test('native shell command history requires Unix PTYs and Python', { skip: true }, () => {});
} else {
const root = mkdtempSync(join(tmpdir(), 'cli-shell-history-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const rustSource = `mod app_paths { pub fn cli_manager_data_dir() -> Result<std::path::PathBuf, String> { Ok(std::env::var("CLI_HISTORY_TEST_DATA").unwrap().into()) } }
#[path=${JSON.stringify(resolve('src-tauri/src/pty/shell_history.rs'))}] mod shell_history;
fn main() { let mut env=std::collections::HashMap::new(); env.insert("ZDOTDIR".to_string(),std::env::var("CLI_HISTORY_TEST_USER_DIR").unwrap()); shell_history::prepare_zsh(&mut env).unwrap(); for (k,v) in env { println!("{k}\\t{v}"); } }
`;
writeFileSync(join(root, 'prepare.rs'), rustSource);
const build = spawnSync(process.env.CLI_MANAGER_TEST_RUSTC ?? 'rustc', [join(root, 'prepare.rs'), '-o', join(root, 'prepare')], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr);
const python = String.raw`
import os, pty, select, signal, time, json, sys, re, base64
config=json.loads(sys.argv[1]); pid,fd=pty.fork()
if pid==0:
 env=os.environ.copy(); env.update(config['env']); env['TERM']='xterm-256color'
 os.execvpe(config['shell'], config['args'], env)
output=b''
def until(marker):
 global output
 data=b''; deadline=time.monotonic()+5
 while marker not in data:
  if time.monotonic()>deadline: raise Exception('prompt timeout: '+repr(data[-1200:]))
  ready,_,_=select.select([fd],[],[],.1)
  if ready:
   chunk=os.read(fd,65536); data+=chunk; output+=chunk
 return data
try:
 until(b'CMH> ')
 os.write(fd,b"printf 'HISTORY_OK\\n'\r"); until(b'CMH> ')
 os.write(fd,b'\x1b[A\r'); until(b'CMH> ')
 os.write(fd,b" printf 'PRIVATE_OK\\n'\r"); until(b'CMH> ')
 os.write(fd,b'echo SHOULD_NOT_RECORD\x15\r'); until(b'CMH> ')
 os.write(fd,b'''python3 -c 'input("CHILD> "); print("CHILD_DONE")'\r'''); until(b'CHILD> ')
 os.write(fd,b'CHILD_INPUT_MUST_NOT_BE_HISTORY\r'); until(b'CMH> ')
 markers=re.findall(rb'\x1b\]777;cli-manager-history;([^;\x07]+);([^;\x07]+);([^\x07]+)\x07',output)
 print(json.dumps({'commands':[base64.b64decode(m[2]).decode() for m in markers], 'ids':[m[1].decode() for m in markers]}))
finally:
 os.kill(pid,signal.SIGTERM)
 os.close(fd)
 os.waitpid(pid,0)
`;
for (const variant of ['zsh', 'zsh-login', 'bash', 'zsh-disabled', 'bash-disabled']) {
  const shell = variant.startsWith('zsh') ? 'zsh' : 'bash';
  const enabled = !variant.endsWith('disabled');
  test(variant + ' records accepted/recalled commands, honors leading spaces and ignores cancelled and child input', { skip: spawnSync(shell, ['--version']).status !== 0 }, () => {
    const directory = join(root, variant);
    spawnSync('mkdir', ['-p', directory]);
    let env = { CLI_MANAGER_COMMAND_HISTORY: enabled ? '1' : '0', CLI_MANAGER_TAB_ID: 'test-session' };
    let args;
    if (shell === 'zsh') {
      writeFileSync(join(directory, '.zshrc'), `PS1='CMH> '\nHISTSIZE=100\nHISTFILE='${directory}/history'\nsetopt HIST_IGNORE_SPACE\n`);
      const prepare = spawnSync(join(root, 'prepare'), [], { encoding: 'utf8', env: { ...process.env, CLI_HISTORY_TEST_DATA: join(directory, 'data'), CLI_HISTORY_TEST_USER_DIR: directory } });
      assert.equal(prepare.status, 0, prepare.stderr);
      for (const line of prepare.stdout.trim().split('\n')) { const index=line.indexOf('\t'); env[line.slice(0,index)]=line.slice(index+1); }
      args=['zsh',variant === 'zsh-login' ? '-il' : '-i'];
    } else {
      const rc = join(directory, 'rc');
      writeFileSync(rc, `PS1='CMH> '\nHISTFILE='${directory}/history'\nHISTCONTROL=ignorespace\n` + readFileSync('src-tauri/src/pty/integration/history.bash','utf8'));
      args=['bash','--noprofile','--rcfile',rc,'-i'];
    }
    const run=spawnSync('python3',['-c',python,JSON.stringify({shell,args,env})],{encoding:'utf8',timeout:25000});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(run.stdout);
    if (!enabled) { assert.deepEqual(result.commands, []); return; }
    assert.deepEqual(result.commands.slice(0,2), ["printf 'HISTORY_OK\\n'", "printf 'HISTORY_OK\\n'"]);
    assert.equal(result.commands.length,3,JSON.stringify(result.commands));
    assert.match(result.commands[2],/^python3 -c /);
    assert.equal(new Set(result.ids).size,result.ids.length);
  });
}

}
