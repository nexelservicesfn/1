const { spawn } = require('child_process');

function run(name, file) {
  const p = spawn(process.execPath, [file], { stdio: 'inherit' });
  p.on('exit', (code) => {
    console.log(`[start] ${name} exited (${code}) — restarting in 3s`);
    setTimeout(() => run(name, file), 3000);
  });
}

run('server', 'server/src/index.js');
run('bot', 'bot/src/index.js');