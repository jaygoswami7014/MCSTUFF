/**
 * In-container process supervisor.
 *
 * Why: exiting the whole container makes Railway recreate it (slow, remounts volume,
 * sometimes gets stuck -> 502 until someone restarts manually). Instead the parent
 * process stays alive and just re-spawns the real server, so a "restart" takes ~1s
 * and the container itself never goes down.
 *
 * `node server.js` / `npm start` both work - server.js supervises itself.
 * Set NO_SUPERVISOR=1 to disable.
 */
const { spawn } = require('child_process');

const RESTART_CODE = 75;          // child exits with this = "restart me please"
const CHILD_FLAG = 'MCSTUFF_CHILD';

function shouldSupervise() {
  return !process.env[CHILD_FLAG] && process.env.NO_SUPERVISOR !== '1';
}

function start(entryFile) {
  let child = null;
  let stopping = false;
  let backoff = 1000;

  function launch() {
    const startedAt = Date.now();
    child = spawn(process.execPath, [entryFile], {
      stdio: 'inherit',
      env: { ...process.env, [CHILD_FLAG]: '1' }
    });

    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return process.exit(0);
      const ranFor = Date.now() - startedAt;
      let wait;
      if (code === RESTART_CODE) {
        console.log('[supervisor] restart requested - starting server again');
        backoff = 1000;
        wait = 300;
      } else {
        // crash: retry with backoff (1s, 2s, 4s ... max 15s); reset if it ran fine for a while
        if (ranFor > 30000) backoff = 1000;
        wait = backoff;
        backoff = Math.min(backoff * 2, 15000);
        console.log('[supervisor] server exited (code=' + code + ', signal=' + signal + ') - restarting in ' + wait + 'ms');
      }
      setTimeout(launch, wait);
    });
  }

  function shutdown(sig) {
    stopping = true;
    if (child) { try { child.kill(sig); } catch {} }
    else process.exit(0);
    // safety net
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  launch();
}

module.exports = { shouldSupervise, start, RESTART_CODE };
