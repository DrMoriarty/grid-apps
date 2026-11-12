/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */
/**
 * cam-bench: headless e2e bench for the kiri CAM slice+prepare pipeline.
 *
 * Bundles the kiri worker (src/kiri/run/worker.js) and minion
 * (src/kiri/run/minion.js) with esbuild, runs them in-process /
 * worker_threads with browser shims, drives them through the same
 * message protocol the kiri client uses (pool_start, slicePre, sync,
 * slice, prepare) and reports wall time of each phase.
 *
 * usage:
 *   node bin/cam-bench/bench.mjs <model.stl> [toolDiam]
 *
 * env knobs (rough op):
 *   STEP (0.4), DOWN (2), LEAVE (0), LEAVEZ (0), ALL (1), INSIDE (1),
 *   SKIPCLEAR (1), SPIRAL (0), STOCKRES (0 = auto)
 * other:
 *   MINION_LOG=1  log minion traffic
 *   CPU_PROF=1    run with --cpu-prof (see README)
 *
 * see README.md for the full recipe (reference model, profiling,
 * determinism checks).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Worker as NodeWorker } from 'worker_threads';
import { pathToFileURL, fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// repo root (bin/cam-bench/*)
const ROOT = path.resolve(HERE, '..', '..');

const [ modelPath, toolDiamArg ] = process.argv.slice(2);
const toolDiam = parseFloat(toolDiamArg || '8');

if (!modelPath || !fs.existsSync(modelPath)) {
    console.error('usage: node bin/cam-bench/bench.mjs <model.stl> [toolDiam]');
    process.exit(1);
}

// ---- esbuild discovery (worktrees have no node_modules of their own;
// bundling works from any nested checkout via ancestor node_modules) ----
function findEsbuild() {
    let dir = ROOT;
    while (true) {
        const p = path.join(dir, 'node_modules', '.bin', 'esbuild');
        if (fs.existsSync(p)) return p;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}

// ---- bench workspace: bundles + wasm copies; cwd is set to it so the
// emscripten manifold module resolves its '../wasm/manifold.wasm' ----
const WORK = path.join(os.tmpdir(), 'cam-bench');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'wasm'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'wasm'))) {
    if (f.endsWith('.wasm')) {
        fs.copyFileSync(path.join(ROOT, 'src', 'wasm', f), path.join(WORK, 'wasm', f));
    }
}
fs.copyFileSync(path.join(HERE, 'pool-shim.mjs'), path.join(WORK, 'pool-shim.mjs'));
process.env.CAM_BENCH_WORK = WORK;
process.chdir(WORK);

const ESBUILD = findEsbuild();
if (!ESBUILD) {
    console.error('esbuild not found (run npm run setup?)');
    process.exit(1);
}

// externals mirror bin/esbuild.config.mjs
const EXTERNALS = [
    'module', 'node:module', './constants', './voronoi_structures',
    './voronoi_ctypes', '../thirdparty/jsbn', './collections',
    './voronoi_predicates', './voronoi_builder', './point_data',
    './segment_data', './cppgen', './voronoi_diagram', './voronoi',
];

function bundle(entry, outfile) {
    const args = [
        path.join(ROOT, entry), '--bundle', '--format=esm', '--platform=browser',
        '--target=es2022', `--define:process.env.NODE_ENV="development"`,
        ...EXTERNALS.map(e => `--external:${e}`), `--outfile=${outfile}`,
    ];
    const r = spawnSync(ESBUILD, args, { stdio: 'pipe' });
    if (r.status !== 0) {
        console.error(r.stderr.toString());
        process.exit(1);
    }
}

console.log('cam-bench: bundling worker + minion...');
bundle('src/kiri/run/worker.js', path.join(WORK, 'kiri-work.mjs'));
bundle('src/kiri/run/minion.js', path.join(WORK, 'kiri-pool.mjs'));

// ---- shims (must precede the worker bundle import) ----
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'navigator', {
    value: {
        hardwareConcurrency: os.cpus().length,
        userAgent: 'cam-bench',
    },
    configurable: true,
});
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.fetch = function (url) {
    if (typeof url === 'string' && url.includes('.wasm')) {
        const p = path.join(WORK, url);
        const buf = fs.readFileSync(p);
        return Promise.resolve({
            arrayBuffer: () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        });
    }
    return Promise.reject(new Error('fetch unsupported: ' + url));
};

// worker_threads backed Worker shim for the minion pool
class WorkerShim {
    constructor(url, opts) {
        const w = new NodeWorker(path.join(WORK, 'pool-shim.mjs'));
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        w.on('message', (v) => {
            if (process.env.MINION_LOG && v && v.cmd) console.log('←minion', v.cmd, 'seq', v.seq);
            this.onmessage && this.onmessage({ data: v });
        });
        w.on('messageerror', (e) => console.error('MINION MSGERROR:', e));
        w.on('error', (e) => {
            console.error('MINION ERROR:', e);
            this.onerror && this.onerror({ preventDefault() {}, error: e });
        });
        this._w = w;
    }
    postMessage(msg, transfer) {
        if (process.env.MINION_LOG && msg && msg.cmd) console.log('→minion', msg.cmd, 'seq', msg.seq);
        this._w.postMessage(msg, transfer || []);
    }
    terminate() {
        return this._w.terminate();
    }
}
globalThis.Worker = WorkerShim;

// ---- import worker bundle (sets self.onmessage = dispatch) ----
await import(pathToFileURL(path.join(WORK, 'kiri-work.mjs')).href);

// ---- load model (binary STL), seat it on the bed like the CAM app ----
function loadSTL(p) {
    const buf = fs.readFileSync(p);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tri = dv.getUint32(80, true);
    const verts = new Float32Array(tri * 9);
    let o = 84;
    for (let i = 0; i < tri; i++) {
        o += 12; // skip normal
        for (let j = 0; j < 9; j++) {
            verts[i * 9 + j] = dv.getFloat32(o, true);
            o += 4;
        }
        o += 2; // attr
    }
    return verts;
}

const vertices = loadSTL(modelPath);

const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
        const v = vertices[i + k];
        if (v < bmin[k]) bmin[k] = v;
        if (v > bmax[k]) bmax[k] = v;
    }
}
const r3 = (v) => Math.round(v * 1000) / 1000;
console.log(`model: ${vertices.length / 9} triangles, bounds min ${bmin.map(r3)} max ${bmax.map(r3)}`);
const zshift = -bmin[2];
for (let i = 2; i < vertices.length; i += 3) vertices[i] += zshift;
bmin[2] += zshift; bmax[2] += zshift;

// ---- CAM settings (defaults mirror conf/defaults.js CAM block) ----
const tools = [
    {
        id: 1000, number: 1, type: 'endmill', name: `end ${toolDiam}mm`,
        metric: true, shaft_diam: toolDiam, shaft_len: 10,
        flute_diam: toolDiam, flute_len: 30, taper_tip: 0,
    },
    {
        id: 1001, number: 2, type: 'endmill', name: 'end 3mm',
        metric: true, shaft_diam: 3, shaft_len: 10,
        flute_diam: 3, flute_len: 30, taper_tip: 0,
    },
];

const settings = {
    mode: 'CAM',
    controller: {
        dark: false, devel: false, units: 'mm', lineType: 'line',
        hidePercent: 0, showLayers: true, edgeangle: 20,
        scene: { showRough: true },
        stockRes: +(process.env.STOCKRES || 0),
    },
    device: {
        new: false, mode: 'CAM', deviceName: 'cam-bench', internal: 0,
        bedHeight: 2.5, bedWidth: 760, bedDepth: 760, maxHeight: 300,
        originCenter: false, spindleMax: 24000,
        gcodeSpace: true, gcodeStrip: false,
        gcodePre: ['G21 ; mm', 'G90 ; abs', 'G0 F6000', 'G1 F1500'],
        gcodePost: ['M30 ; end'],
        gcodeDwell: ['G4 P{time}'],
        gcodeSpindle: ['M3 S{speed}'],
        gcodeChange: ['M6 T{tool}'],
        gcodeFExt: 'nc', gcodeTime: 0,
    },
    process: {
        processName: 'cam-bench',
        camZTop: 0, camZBottom: 0, camZAnchor: 'middle', camZOffset: 0, camZClearance: 1,
        camStockOffset: true, camStockX: 5, camStockY: 5, camStockZ: 5,
        camStockClipTo: false, camStockIndexed: false, camStockIndexGrid: true,
        camDepthFirst: true, camTolerance: 0, camFlatness: 0.001, camExpertFast: false,
        camFastFeed: 6000, camFastFeedZ: 300, camFirstZMax: true, camForceZMax: false,
        camFullEngage: 0.8, camMillDirection: 'climb', camOriginCenter: false,
        camOriginTop: true, camOriginOffX: 0, camOriginOffY: 0, camOriginOffZ: 0,
        camRoundCorners: true, camToolInit: true,
        ops: [
            {
                type: 'rough', tool: 1000, direction: 'climb', spindle: 1000,
                down: +(process.env.DOWN || 2),
                step: +(process.env.STEP || 0.4),
                rate: 1000, plunge: 250,
                leave: +(process.env.LEAVE || 0),
                leavez: +(process.env.LEAVEZ || 0),
                all: process.env.ALL !== '0',
                flats: true,
                inside: process.env.INSIDE !== '0',
                omitthru: false,
                skipclear: process.env.SKIPCLEAR !== '0',
                spiral: process.env.SPIRAL === '1',
                spiral_finish: true,
                ov_topz: 0, ov_botz: 0,
            },
        ],
        op2: [],
    },
    stock: {
        x: (bmax[0] - bmin[0]) + 10,
        y: (bmax[1] - bmin[1]) + 10,
        z: (bmax[2] - bmin[2]) + 10,
        center: {
            x: (bmin[0] + bmax[0]) / 2,
            y: (bmin[1] + bmax[1]) / 2,
            z: (bmin[2] + bmax[2]) / 2,
        },
    },
    tools,
    widget: { w1: {} },
};

// ---- message plumbing (client protocol) ----
const WID = 'w1';
let seqid = 1;
const running = new Map();
let sliceStart = 0, prepStart = 0;
let sliceDone = false, prepDone = false;
let sliceCount = 0;

function sendMsg(task, data, onreply) {
    const seq = seqid++;
    if (onreply) running.set(seq, onreply);
    globalThis.onmessage({ data: { seq, task, time: Date.now(), data } });
}

globalThis.postMessage = function (msg) {
    const rec = running.get(msg.seq);
    if (msg.done) running.delete(msg.seq);
    const d = msg.data;
    if (msg.task === 'slice' && d) {
        if (d.update !== undefined && msg.data.updateStatus) {
            console.log(`  [slice] ${Math.round(d.update * 100)}% ${d.updateStatus}`);
        }
        if (d.error) console.log('SLICE ERROR', d.error);
        if (d.slices !== undefined) sliceCount = d.slices;
    }
    if (msg.task === 'prepare' && d && d.progress !== undefined) {
        const pct = Math.round(d.progress * 100);
        if (pct < 100) console.log(`  [prep] ${pct}%`);
    }
    if (rec) rec(d, msg);
    if (msg.task === 'slice' && (msg.done || msg.error)) {
        console.log(`SLICE DONE in ${Date.now() - sliceStart} ms (slices: ${sliceCount})`);
        sliceDone = true;
    }
    if (msg.task === 'prepare' && (msg.done || msg.error)) {
        console.log(`PREPARE DONE in ${Date.now() - prepStart} ms`);
        prepDone = true;
    }
};

// ---- run ----
const t0 = Date.now();
sendMsg('pool_start', { url: 'minion' }, () => {});
sendMsg('slicePre', { settings }, () => {});
sendMsg('sync', {
    id: WID, group: 'g1', anno: {}, meta: {},
    position: { x: 0, y: 0, z: 0 },
    track: {
        id: WID, pos: { x: 0, y: 0, z: 0 }, synth: false,
        box: { w: bmax[0] - bmin[0], h: bmax[1] - bmin[1], d: bmax[2] - bmin[2] },
        top: bmax[2], tzoff: 0,
    },
    vertices,
}, () => {});

console.log(`=== slice (tool Ø${toolDiam})`);
sliceStart = Date.now();
sendMsg('slice', { id: WID, settings }, () => {});

const waitSlice = setInterval(() => {
    if (!sliceDone) return;
    clearInterval(waitSlice);
    console.log(`=== prepare`);
    prepStart = Date.now();
    sendMsg('prepare', { settings }, () => {});
    const waitPrep = setInterval(() => {
        if (!prepDone) return;
        clearInterval(waitPrep);
        console.log(`TOTAL ${Date.now() - t0} ms`);
        process.exit(0);
    }, 250);
}, 250);

setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(2);
}, 30 * 60 * 1000);
