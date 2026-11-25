/*
 * tools/mem-cap.mjs - a hard memory cap for child programs (used by tools/rust-mutate.mjs).
 *
 * Why: a mutant can make a test binary allocate without bound. When RAM runs out, the kernel OOM killer picks its
 * victim across the whole session, and that took the desktop app down (a dfo_core test binary at 22 GB). A cap has to
 * hold the runaway inside a box of its own, with the parent and everything else outside it.
 *
 * Mechanisms, chosen by probeMechanism() from what the child process really sees, never by assumption:
 *   systemd  systemd-run --user --scope -p MemoryMax=<cap> -p MemorySwapMax=0 <cmd>
 *            a transient cgroup v2 scope. The kernel OOM killer chooses victims only inside the scope, so the parent
 *            and the rest of the session stay outside it. OOMPolicy=continue lets cargo outlive the killed test and report
 *            the SIGKILL, so the run is counted as a cap death. Preferred. --expand-environment=no stops systemd-run from
 *            rewriting `${...}` in the wrapped arguments, which broke the probe's own script.
 *   prlimit  prlimit --data=<cap> <cmd>. RLIMIT_DATA: an allocation past the cap fails inside the process. No cgroup,
 *            so the kernel OOM killer is not contained; the cap holds only while the sum of workers fits in RAM (see
 *            planMemory). Fallback when no user manager can create a scope.
 *   none     neither works: the gate refuses to run unless --no-mem-cap is given.
 *
 * ASSUMPTION: the cap values here are judgement, not measured: the default split gives each worker an equal share of
 * half of RAM, and no worker gets less than MIN_CAP. A real rustc build of dfo-core was not measured under the cap.
 */
import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';

export const MiB = 2 ** 20;
export const GiB = 2 ** 30;
/** The smallest default cap per worker. Below it a rustc build of dfo-core is the wrong size, so the default drops workers. */
export const MIN_CAP = GiB;

const fmtMiB = (bytes) => `${Math.round(bytes / MiB)} MiB`;
const floorMiB = (bytes) => Math.floor(bytes / MiB) * MiB;

/** `2G`, `512M`, `1.5GiB`, `300` (a bare number is MiB). Throws on anything else. */
export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)(?:i?B)?$/i.exec(String(text).trim());
  if (!m) throw new Error(`--max-mem: want a size such as 2G, 512M or 300 (MiB), got "${text}"`);
  const unit = { '': MiB, K: 1024, M: MiB, G: GiB }[m[2].toUpperCase()];
  return Math.floor(Number(m[1]) * unit);
}

/**
 * How many workers run at once and how much each may use, so that the workers together stay within half of RAM.
 *   jobsOpt    --jobs, or undefined for the default
 *   maxMemOpt  --max-mem in bytes, or undefined for the default (an equal share of the budget)
 *   noCap      --no-mem-cap: no cap at all (jobs default as usual)
 * The default reduces the number of workers until each share is at least MIN_CAP. An explicit --jobs or --max-mem is
 * never silently changed: if the pair does not fit the budget, this throws.
 */
export function planMemory({ totalBytes = totalmem(), cores, jobsOpt, maxMemOpt, noCap = false }) {
  const budget = Math.floor(totalBytes / 2);
  const defaultJobs = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  if (jobsOpt !== undefined && (!Number.isInteger(jobsOpt) || jobsOpt < 1)) throw new Error(`--jobs: want a positive integer, got ${jobsOpt}`);
  if (noCap) return { budget, capBytes: null, jobs: jobsOpt ?? defaultJobs };
  if (maxMemOpt !== undefined) {
    if (jobsOpt !== undefined && jobsOpt * maxMemOpt > budget) {
      throw new Error(`--jobs ${jobsOpt} x --max-mem ${fmtMiB(maxMemOpt)} = ${fmtMiB(jobsOpt * maxMemOpt)} exceeds half of RAM (${fmtMiB(budget)}); lower one of them`);
    }
    const fit = Math.max(1, Math.floor(budget / maxMemOpt));
    return { budget, capBytes: maxMemOpt, jobs: jobsOpt ?? Math.min(defaultJobs, fit) };
  }
  if (jobsOpt !== undefined) {
    const capBytes = floorMiB(budget / jobsOpt);
    if (capBytes < MIN_CAP) throw new Error(`--jobs ${jobsOpt}: each worker would get ${fmtMiB(capBytes)} of the ${fmtMiB(budget)} budget (under ${fmtMiB(MIN_CAP)}); lower --jobs or pass --max-mem`);
    return { budget, capBytes, jobs: jobsOpt };
  }
  let jobs = defaultJobs;
  while (jobs > 1 && floorMiB(budget / jobs) < MIN_CAP) jobs -= 1;
  return { budget, capBytes: floorMiB(budget / jobs), jobs };
}

/** The program and arguments that run `cmd args` under the mechanism. `none` (or no cap) runs them unchanged. */
export function wrap(mech, capBytes, cmd, args) {
  if (mech === 'systemd') {
    return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', '--expand-environment=no', '-p', `MemoryMax=${capBytes}`, '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue', cmd, ...args] };
  }
  if (mech === 'prlimit') return { cmd: 'prlimit', args: [`--data=${capBytes}`, cmd, ...args] };
  return { cmd, args };
}

/** Runs inside the wrapper (as `node -e`): prints the limits the kernel holds for this very process. */
function limitsOfThisProcess() {
  const fs = require('node:fs');
  const cg = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
  const dir = cg ? `/sys/fs/cgroup${cg.slice(3)}` : null;
  const read = (f) => { try { return fs.readFileSync(`${dir}/${f}`, 'utf8').trim(); } catch { return null; } };
  const data = fs.readFileSync('/proc/self/limits', 'utf8').split('\n').find((l) => l.startsWith('Max data size'));
  console.log(JSON.stringify({ memoryMax: dir ? read('memory.max') : null, swapMax: dir ? read('memory.swap.max') : null, dataSoft: data ? data.split(/\s+/)[3] : null }));
}

/**
 * Picks the first mechanism whose wrapper really applies the cap: the child reads its own limit back. A wrapper that
 * exits 0 without a cap (systemd can warn and carry on when a controller is not delegated) does not count.
 */
export function probeMechanism(capBytes) {
  const script = `(${limitsOfThisProcess.toString()})()`;
  const ask = (mech) => {
    const w = wrap(mech, capBytes, process.execPath, ['-e', script]);
    const r = spawnSync(w.cmd, w.args, { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0 || !r.stdout) return null;
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
  };
  const sys = ask('systemd');
  const sysMax = Number(sys?.memoryMax);
  if (sys && sysMax <= capBytes && capBytes - sysMax < 4096 && sys.swapMax === '0') return 'systemd';
  const pr = ask('prlimit');
  if (pr && pr.dataSoft === String(capBytes)) return 'prlimit';
  return 'none';
}

export { fmtMiB };
