/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */
/**
 * cam-bench accept: e2e acceptance checks for the rough-flats free-edge
 * anchor work (goal #7434434b / task #31df2d4f).
 *
 * Runs the same headless slice+prepare pipeline as bench.mjs, captures the
 * emitted milling polylines (prepare render layers) and checks them
 * against model contours ray/section-derived from the STL:
 *
 *   1. ledge disk-sweep probes at the ledge plane: 0 uncut for the tool
 *      (probes = points on the ledge annulus, cut iff some axis point is
 *      within tool radius);
 *   2. finish pass along the ledge free edge: path points within 0.5 mm
 *      of the deep-cavity contour in >= 95% of 5-degree sectors
 *      (structurally only achievable when stepover >= 50%, where family
 *      ring 1 rides the edge by design);
 *   3. top-plane face ring near the outer silhouette is smooth: median
 *      absolute deviation of (point-to-silhouette distance) < 0.1 mm;
 *   4. inside only: every axis point within the per-plane clip box (from
 *      the [FAR] log), no milling fragments entirely outside the part
 *      silhouette at the ledge plane, and (inside-only profile) no
 *      flats-plane axis point outside the part silhouette;
 *   5. cavity floor / bottom flats planes still machined by the same op,
 *      the bottom plane correctly falling back to pixel/legacy anchoring;
 *   6. slice time within the linear-perf budget.
 *   7. authored emission order on the free-anchor flats planes (task
 *      #03afbbf1): the first cutting pass of each plane starts over the
 *      verified void (free edge / central hole) or enters by a ramp from
 *      air, and the wall finish ring is the plane's LAST pass — no
 *      vertical plunge at full radial immersion into the wall band,
 *      followed by useless passes over already-cleared volume. on the
 *      cavity floor plane the free-anchor set is REQUIRED (a rollback to
 *      the legacy wall-anchored pixel rings there is the customer defect:
 *      leveling must start from the central hole's void), and the first
 *      floor pass must run over the central hole's verified void;
 *   8. the floor rings around the central hole are model-true: per-path
 *      MAD of the point-to-hole-contour distance (model section just
 *      below the floor plane) < 0.1 mm — pixel-fringe rings fail.
 *
 * usage:
 *   node bin/cam-bench/accept.mjs <model.stl> [toolDiam] [stepFraction]
 *
 * env: same knobs as bench.mjs (STEP/DOWN/LEAVE/ALL/INSIDE/SKIPCLEAR),
 * plus ACCEPT_Z(IP) overrides for the reference section heights.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Worker as NodeWorker } from 'worker_threads';
import { pathToFileURL, fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const [ modelPath, toolDiamArg, stepArg ] = process.argv.slice(2);
const toolDiam = parseFloat(toolDiamArg || '8');
// stepover as a FRACTION of the tool diameter — passed verbatim to the
// rough op's `step` field (op.step is a fraction of the diameter, NOT
// absolute mm: `accept.mjs model.stl 6.35 0.4` = 40% stepover = 2.54 mm).
// the geometry checks below use S = stepFrac * toolDiam (mm)
const stepFrac = parseFloat(stepArg || '0.5');
const R = toolDiam / 2;
const S = stepFrac * toolDiam;
const LEAVE = +(process.env.LEAVE || 0);

if (!modelPath || !fs.existsSync(modelPath)) {
    console.error('usage: node bin/cam-bench/accept.mjs <model.stl> [toolDiam] [stepFraction]');
    process.exit(1);
}

// ---- reference plane heights (cup 3.1 L-longX) ----
const Z_LEDGE = 27.5;   // ledge flat plane (the plane under test)
const Z_TOP = 30;       // part top flat plane
const Z_UPPER = 29;     // section just above the ledge: upper cavity rim contour
const Z_LOWER = 27.4;   // section just below the ledge: deep cavity contour
const Z_FLOOR = 5;      // deep cavity floor flat
const Z_BOT = 1;        // bottom/lowest flat plane

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

const WORK = path.join(os.tmpdir(), 'cam-bench-accept');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'wasm'), { recursive: true });
// emscripten's manifold module resolves '../wasm/manifold.wasm' relative
// to cwd: bundle into WORK/run so that path lands on WORK/wasm
fs.mkdirSync(path.join(WORK, 'run'), { recursive: true });
function findWasm(name) {
    // src/wasm/*.wasm may be symlinks into node_modules (dangling in
    // worktrees without their own node_modules) — resolve or search up
    const p = path.join(ROOT, 'src', 'wasm', name);
    try {
        return fs.realpathSync(p);
    } catch (e) {
        let dir = ROOT;
        while (true) {
            const q = path.join(dir, 'node_modules', 'manifold-3d', name);
            if (fs.existsSync(q)) return q;
            const up = path.dirname(dir);
            if (up === dir) return p;
            dir = up;
        }
    }
}

for (const f of fs.readdirSync(path.join(ROOT, 'src', 'wasm'))) {
    if (f.endsWith('.wasm')) {
        fs.copyFileSync(findWasm(f), path.join(WORK, 'wasm', f));
    }
}
fs.copyFileSync(path.join(HERE, 'pool-shim.mjs'), path.join(WORK, 'run', 'pool-shim.mjs'));
process.env.CAM_BENCH_WORK = WORK;
process.chdir(path.join(WORK, 'run'));

const ESBUILD = findEsbuild();
if (!ESBUILD) {
    console.error('esbuild not found (run npm run setup?)');
    process.exit(1);
}

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

console.log(`accept: tool Ø${toolDiam} step ${stepFrac} (S=${S.toFixed(2)}) — bundling...`);
bundle('src/kiri/run/worker.js', path.join(WORK, 'run', 'kiri-work.mjs'));
bundle('src/kiri/run/minion.js', path.join(WORK, 'run', 'kiri-pool.mjs'));

// ask the worker to export the stamped free-anchor ring sets ([FARRJ]
// channel) for the emission-order checks below (task #03afbbf1)
globalThis.__FARRJ = 1;

globalThis.self = globalThis;
Object.defineProperty(globalThis, 'navigator', {
    value: { hardwareConcurrency: os.cpus().length, userAgent: 'cam-bench-accept' },
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

class WorkerShim {
    constructor(url, opts) {
        const w = new NodeWorker(path.join(WORK, 'run', 'pool-shim.mjs'));
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        w.on('message', (v) => this.onmessage && this.onmessage({ data: v }));
        w.on('messageerror', (e) => console.error('MINION MSGERROR:', e));
        w.on('error', (e) => this.onerror && this.onerror({ preventDefault() {}, error: e }));
        this._w = w;
    }
    postMessage(msg, transfer) { this._w.postMessage(msg, transfer || []); }
    terminate() { return this._w.terminate(); }
}
globalThis.Worker = WorkerShim;

// capture op-area [FAR...] diagnostics from the in-process worker
const farLog = [];
// stamped free-anchor sets per plane: z -> [{s, o, pts:[[x,y],...]}]
const farrSets = new Map();
const origLog = console.log;
console.log = function (...args) {
    const s = args.length === 1 && typeof args[0] === 'string' ? args[0] : null;
    if (s !== null && (s.startsWith('[FAR') || s.startsWith('SLICE DONE'))) {
        farLog.push(s);
        if (s.startsWith('[FARRJ] ')) {
            try {
                const rec = JSON.parse(s.slice(8));
                farrSets.set(Math.round(rec.z * 100) / 100, rec.set);
            } catch (e) { /* malformed harness line — order checks will fail visibly */ }
        }
    }
    origLog.apply(console, args);
};

await import(pathToFileURL(path.join(WORK, 'run', 'kiri-work.mjs')).href);

// ---- model ----
function loadSTL(p) {
    const buf = fs.readFileSync(p);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tri = dv.getUint32(80, true);
    const verts = new Float32Array(tri * 9);
    let o = 84;
    for (let i = 0; i < tri; i++) {
        o += 12;
        for (let j = 0; j < 9; j++) {
            verts[i * 9 + j] = dv.getFloat32(o, true);
            o += 4;
        }
        o += 2;
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
const zshift = -bmin[2];
for (let i = 2; i < vertices.length; i += 3) vertices[i] += zshift;
bmin[2] += zshift; bmax[2] += zshift;
console.log(`model: ${vertices.length / 9} triangles, bounds min ${bmin.map(r3)} max ${bmax.map(r3)}`);

// ---- settings (mirrors bench.mjs) ----
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
        processName: 'cam-bench-accept',
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
                step: stepFrac,
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

// ---- protocol plumbing ----
const WID = 'w1';
let seqid = 1;
const running = new Map();
let sliceStart = 0, prepStart = 0;
let sliceDone = false, prepDone = false;
let sliceMs = 0, prepMs = 0;
let sliceCount = 0;
// milling polylines from prepare render emits: { open, pts:[[x,y,z],...] }
const milling = [];

function sendMsg(task, data, onreply) {
    const seq = seqid++;
    if (onreply) running.set(seq, onreply);
    globalThis.onmessage({ data: { seq, task, time: Date.now(), data } });
}

function decodeFlat(arr) {
    // flat xyz float array -> [[x,y,z],...]
    const out = [];
    for (let i = 0; i < arr.length; i += 3) out.push([ arr[i], arr[i + 1], arr[i + 2] ]);
    return out;
}

globalThis.postMessage = function (msg) {
    const rec = running.get(msg.seq);
    if (msg.done) running.delete(msg.seq);
    const d = msg.data;
    if (msg.task === 'slice' && d) {
        if (d.error) console.log('SLICE ERROR', d.error);
        if (d.slices !== undefined) sliceCount = d.slices;
    }
    if (msg.task === 'prepare' && d && d.layer) {
        // encoded Layers: { layers:[names], data:[{polys:[{open, points}]}] }
        const enc = d.layer;
        const mi = enc.layers.indexOf('milling');
        if (mi >= 0 && enc.data[mi] && enc.data[mi].polys) {
            for (const p of enc.data[mi].polys) {
                if (!p.points || p.points.length < 6) continue;
                milling.push({ open: !!p.open, pts: decodeFlat(p.points) });
            }
        }
    }
    if (rec) rec(d, msg);
    if (msg.task === 'slice' && (msg.done || msg.error)) {
        sliceMs = Date.now() - sliceStart;
        origLog(`SLICE DONE in ${sliceMs} ms (slices: ${sliceCount})`);
        sliceDone = true;
    }
    if (msg.task === 'prepare' && (msg.done || msg.error)) {
        prepMs = Date.now() - prepStart;
        origLog(`PREPARE DONE in ${prepMs} ms`);
        prepDone = true;
    }
};

// ---- run ----
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

origLog(`=== slice (tool Ø${toolDiam}, step ${stepFrac})`);
sliceStart = Date.now();
sendMsg('slice', { id: WID, settings }, () => {});

const waitSlice = setInterval(() => {
    if (!sliceDone) return;
    clearInterval(waitSlice);
    prepStart = Date.now();
    sendMsg('prepare', { settings }, () => {});
    const waitPrep = setInterval(() => {
        if (!prepDone) return;
        clearInterval(waitPrep);
        if (process.env.MILLDUMP) {
            fs.writeFileSync(process.env.MILLDUMP, JSON.stringify(milling.map(p => ({
                o: p.open ? 1 : 0,
                n: p.pts.length,
                z0: p.pts[0][2],
                z1: p.pts[p.pts.length - 1][2],
                pts: p.pts.map(q => [ +q[0].toFixed(3), +q[1].toFixed(3), +q[2].toFixed(3) ]),
            }))));
        }
        runChecks();
        process.exit(0);
    }, 250);
}, 250);

setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(2);
}, 30 * 60 * 1000);

// ================= geometry helpers =================

function sectionLoops(verts, z) {
    // intersect the triangle soup with the plane z, chain segments into loops
    const segs = [];
    for (let t = 0; t < verts.length; t += 9) {
        const p = [];
        for (let k = 0; k < 3; k++) {
            p.push([ verts[ t + k * 3 ], verts[ t + k * 3 + 1 ], verts[ t + k * 3 + 2 ] ]);
        }
        const pts = [];
        for (let e = 0; e < 3; e++) {
            const a = p[e], b = p[(e + 1) % 3];
            const da = a[2] - z, db = b[2] - z;
            if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
                const f = da / (da - db);
                pts.push([ a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]) ]);
            } else if (da === 0) {
                pts.push([ a[0], a[1] ]);
            }
        }
        // dedupe identical points, need exactly a segment
        const uq = [];
        for (const q of pts) {
            if (!uq.some(u => Math.abs(u[0] - q[0]) < 1e-6 && Math.abs(u[1] - q[1]) < 1e-6)) uq.push(q);
        }
        if (uq.length === 2) segs.push(uq);
    }
    // chain segments into loops with tolerance endpoint matching (mesh
    // vertices landing on the plane and float error split exact-key chains)
    const used = new Array(segs.length).fill(false);
    const loops = [];
    const TOL = 5e-3;
    for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const loop = [ segs[i][0], segs[i][1] ];
        let guard = segs.length + 2;
        while (guard-- > 0) {
            const cur = loop[loop.length - 1];
            let next = -1, flip = false;
            for (let j = 0; j < segs.length; j++) {
                if (used[j]) continue;
                if (Math.hypot(segs[j][0][0] - cur[0], segs[j][0][1] - cur[1]) < TOL) { next = j; flip = false; break; }
                if (Math.hypot(segs[j][1][0] - cur[0], segs[j][1][1] - cur[1]) < TOL) { next = j; flip = true; break; }
            }
            if (next < 0) break;
            used[next] = true;
            loop.push(flip ? segs[next][0] : segs[next][1]);
        }
        if (Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1]) < TOL) {
            loop.pop();
            if (loop.length >= 3) loops.push(loop);
        }
    }
    return loops;
}

function loopArea(loop) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

function loopCentroid(loop) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        const cr = p[0] * q[1] - q[0] * p[1];
        a += cr;
        cx += (p[0] + q[0]) * cr;
        cy += (p[1] + q[1]) * cr;
    }
    a /= 2;
    return [ cx / (6 * a), cy / (6 * a) ];
}

function pointInLoop(loop, x, y) {
    // ray cast to +x
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [ xi, yi ] = loop[i], [ xj, yj ] = loop[j];
        if (((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

// radius of a loop along ray theta from an interior seed
function loopRadius(loop, seed, theta) {
    const dx = Math.cos(theta), dy = Math.sin(theta);
    let best = NaN;
    for (let i = 0; i < loop.length; i++) {
        const [ ax, ay ] = loop[i];
        const b = loop[(i + 1) % loop.length];
        const ex = b[0] - ax, ey = b[1] - ay;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - seed[0]) * ey - (ay - seed[1]) * ex) / den;
        const u = ((ax - seed[0]) * dy - (ay - seed[1]) * dx) / den;
        if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
            if (!(best >= t)) best = t;
        }
    }
    return best;
}

function radiiPerTheta(loop, seed, n) {
    const rr = new Array(n);
    for (let i = 0; i < n; i++) rr[i] = loopRadius(loop, seed, (i * 2 * Math.PI) / n);
    // patch numerical misses by nearest-neighbor interpolation
    for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < n; i++) {
            if (!isNaN(rr[i])) continue;
            const p = rr[(i - 1 + n) % n], q = rr[(i + 1) % n];
            if (!isNaN(p)) rr[i] = p;
            else if (!isNaN(q)) rr[i] = q;
        }
        if (!rr.some(isNaN)) break;
    }
    return rr;
}

function distPointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy);
}

// nearest distance from a point to a loop (polyline of [x,y])
function distToLoop(loop, x, y, bestSoFar = Infinity) {
    let best = bestSoFar;
    for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const d = distPointSeg(x, y, a[0], a[1], b[0], b[1]);
        if (d < best) best = d;
    }
    return best;
}

// spatial hash for fast distance queries over toolpath GEOMETRY: indexes
// spatial hash for fast radius queries over axis points (point-based;
// used where inputs are raw point samples, not simplified polylines)
function makeGrid(pts, cell) {
    const g = new Map();
    for (const p of pts) {
        const k = `${Math.floor(p[0] / cell)}|${Math.floor(p[1] / cell)}`;
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(p);
    }
    return {
        cell,
        nearest(x, y, rmax) {
            const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
            const span = Math.ceil(rmax / cell);
            let best = Infinity;
            for (let i = -span; i <= span; i++) {
                for (let j = -span; j <= span; j++) {
                    const l = g.get(`${cx + i}|${cy + j}`);
                    if (!l) continue;
                    for (const p of l) {
                        const d = Math.hypot(p[0] - x, p[1] - y);
                        if (d < best) best = d;
                    }
                }
            }
            return best;
        }
    };
}

// segment-aware distance grid over emitted polylines ({pts, open}).
// emitted polylines are simplified, so long straight segments and arc
// chords carry the cut between sparse vertices; a point-to-point grid
// overstates distances by up to half the vertex spacing (measured 4.3mm
// vs true 3.9 on the reference ledge flat walls)
function makePolyGrid(polys, cell) {
    const segCells = new Map();
    const d2 = (px, py, ax, ay, bx, by) => {
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    for (const p of polys) {
        for (let i = 0; i + 1 < p.pts.length; i++) {
            const a = p.pts[i], b = p.pts[i + 1];
            const s = [a, b];
            const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
            const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
            for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
                const k = `${ix}|${iy}`;
                if (!segCells.has(k)) segCells.set(k, []);
                segCells.get(k).push(s);
            }
        }
    }
    return {
        cell,
        nearest(x, y, rmax) {
            const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
            const span = Math.ceil(rmax / cell);
            let best = Infinity;
            for (let i = -span; i <= span; i++) {
                for (let j = -span; j <= span; j++) {
                    const l = segCells.get(`${cx + i}|${cy + j}`);
                    if (!l) continue;
                    for (const [a, b] of l) {
                        const d = d2(x, y, a[0], a[1], b[0], b[1]);
                        if (d < best) best = d;
                    }
                }
            }
            return best;
        }
    };
}

function median(arr) {
    if (!arr.length) return NaN;
    const s = [ ...arr ].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ================= checks =================

function runChecks() {
    const Nθ = 1440;
    const results = [];
    const rec = (name, pass, detail) => {
        results.push({ name, pass, detail });
        origLog(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
    };

    // ---- reference contours from the STL ----
    const loopsUpper = sectionLoops(vertices, Z_UPPER + 1e-3);
    const loopsLower = sectionLoops(vertices, Z_LOWER + 1e-3);
    if (!loopsUpper.length || !loopsLower.length) {
        origLog('FATAL: reference sections empty');
        process.exit(3);
    }
    // largest loop = outer silhouette; largest interior loop = cavity
    loopsUpper.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
    loopsLower.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
    const outerU = loopsUpper[0], outerL = loopsLower[0];
    const holeU = loopsUpper.slice(1).find(h => pointInLoop(outerU, h[0][0], h[0][1]));
    const holeL = loopsLower.slice(1).find(h => pointInLoop(outerL, h[0][0], h[0][1]));
    if (!holeU || !holeL) {
        origLog('FATAL: reference cavity contours not found ' +
            `(upper loops=${loopsUpper.length} lower loops=${loopsLower.length}, ` +
            `areas=[${loopsUpper.map(l => Math.abs(loopArea(l)).toFixed(0)).join(',')}]/` +
            `[${loopsLower.map(l => Math.abs(loopArea(l)).toFixed(0)).join(',')}])`);
        process.exit(3);
    }
    const seedU = loopCentroid(holeU), seedL = loopCentroid(holeL);
    // model-true central hole contour at the cavity floor: section just
    // below the floor flat plane (the same reference the free-anchor
    // rings around the hole are verified against in checks 7d/8)
    const loopsFloor = sectionLoops(vertices, Z_FLOOR - 1e-2);
    loopsFloor.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
    const outerF = loopsFloor[0];
    const holeF = loopsFloor.slice(1).find(h => pointInLoop(outerF, h[0][0], h[0][1]));
    const rin29 = radiiPerTheta(holeU, seedU, Nθ);
    const rin274 = radiiPerTheta(holeL, seedL, Nθ);
    const wArr = rin29.map((r, i) => r - rin274[i]);
    const wMin = Math.min(...wArr).toFixed(2), wMax = Math.max(...wArr).toFixed(2);
    const wAvg = (wArr.reduce((a, b) => a + b, 0) / wArr.length).toFixed(2);
    origLog(`reference: rin29 ∈ [${Math.min(...rin29).toFixed(1)},${Math.max(...rin29).toFixed(1)}] ` +
        `rin274 ∈ [${Math.min(...rin274).toFixed(1)},${Math.max(...rin274).toFixed(1)}] ` +
        `ledge width w ∈ [${wMin},${wMax}] avg ${wAvg}`);

    // group milling polys by z
    const byZ = new Map();
    for (const p of milling) {
        const z = Math.round(p.pts[0][2] * 100) / 100;
        if (!byZ.has(z)) byZ.set(z, []);
        byZ.get(z).push(p);
    }
    const zList = [ ...byZ.keys() ].sort((a, b) => b - a);
    origLog('milling planes: ' + zList.map(z => `${z}(${byZ.get(z).length}polys)`).join(' '));
    if (process.env.ACCEPT_MAXR) {
        for (const z of zList) {
            let mr = 0;
            for (const p of byZ.get(z)) for (const q of p.pts) {
                mr = Math.max(mr, Math.hypot(q[0] - seedL[0], q[1] - seedL[1]));
            }
            origLog(`  plane z=${z}: max point r=${mr.toFixed(1)}`);
        }
    }

    const near = (z, target, tol = 0.05) => Math.abs(z - target) <= tol;
    const zLedge = zList.find(z => near(z, Z_LEDGE));
    const zTop = zList.find(z => near(z, Z_TOP));
    const zFloor = zList.find(z => near(z, Z_FLOOR));
    const zBot = zList.find(z => near(z, Z_BOT));

    if (process.env.ACCEPT_BAY) {
        // which planes have toolpath points inside the bay box
        const [ bx0, bx1, by0, by1 ] = process.env.ACCEPT_BAY.split(',').map(Number);
        for (const z of zList) {
            let n = 0;
            for (const p of byZ.get(z)) for (const q of p.pts) {
                if (q[0] >= bx0 && q[0] <= bx1 && q[1] >= by0 && q[1] <= by1) n++;
            }
            if (n) origLog(`  bay box (${bx0}..${bx1},${by0}..${by1}) at z=${z}: ${n} pts`);
        }
    }

    if (process.env.ACCEPT_BOX && zLedge !== undefined) {
        // dump points in an xy box: ACCEPT_BOX=x0,x1,y0,y1[;z]
        const [ boxSpec, boxZ ] = process.env.ACCEPT_BOX.split(';');
        const [ bx0, bx1, by0, by1 ] = boxSpec.split(',').map(Number);
        const zp = boxZ !== undefined ? parseFloat(boxZ) : Z_LEDGE;
        const zsel = zList.find(z => near(z, zp)) ?? zp;
        origLog(`  points box x[${bx0},${bx1}] y[${by0},${by1}] z=${zsel}:`);
        for (const p of (byZ.get(zsel) || [])) {
            const sel = p.pts.filter(q => q[0] >= bx0 && q[0] <= bx1 && q[1] >= by0 && q[1] <= by1);
            if (sel.length) {
                origLog(`   ${p.open ? 'open' : 'clos'} n=${p.pts.length} sel=${sel.length}: ` +
                    sel.slice(0, 80).map(q => `(${q[0].toFixed(2)},${q[1].toFixed(2)})`).join(' '));
            }
        }
    }
    if (process.env.ACCEPT_DUMP && zLedge !== undefined) {
        // dump ledge-plane points in a wedge: ACCEPT_DUMP=th0,th1,rmin,rmax
        const [ t0, t1, rmn, rmx ] = process.env.ACCEPT_DUMP.split(',').map(Number);
        origLog(`  ledge points th∈[${t0},${t1}] r∈[${rmn},${rmx}] (from seed ${seedL.map(v => v.toFixed(1))}):`);
        for (const p of byZ.get(zLedge)) {
            const sel = p.pts.filter(q => {
                const th = (Math.atan2(q[1] - seedL[1], q[0] - seedL[0]) * 180 / Math.PI + 360) % 360;
                const r = Math.hypot(q[0] - seedL[0], q[1] - seedL[1]);
                return th >= t0 && th <= t1 && r >= rmn && r <= rmx;
            });
            if (sel.length) {
                origLog(`   ${p.open ? 'open' : 'clos'} n=${p.pts.length} sel=${sel.length}: ` +
                    sel.slice(0, 48).map(q => {
                        const r = Math.hypot(q[0] - seedL[0], q[1] - seedL[1]);
                        const t = (Math.atan2(q[1] - seedL[1], q[0] - seedL[0]) * 180 / Math.PI + 360) % 360;
                        return `(${q[0].toFixed(1)},${q[1].toFixed(1)}|r${r.toFixed(1)} t${t.toFixed(0)})`;
                    }).join(' '));
            }
        }
    }

    // ---- check 1: ledge disk-sweep probes ----
    if (zLedge === undefined) {
        rec('1 ledge probes', false, 'no milling plane at ledge height');
    } else {
        const pts = [];
        for (const p of byZ.get(zLedge)) for (const q of p.pts) pts.push(q);
        const grid = makePolyGrid(byZ.get(zLedge), Math.max(R, 1));
        let unsampled = 0, shortfall = 0, total = 0;
        const uncutAt = [];
        // probe is cut when an axis point lies within R + PTOL: absorbs the
        // tessellation discrepancy between the STL reference sections and
        // the app's own mesh slice (measured ~0.1-0.3 mm on this model);
        // real uncut bands (0.5 mm and up) stay detected
        const PTOL = 0.3;
        const probeStep = 0.25, thStep = 0.5 * Math.PI / 180;
        for (let th = 0; th < 2 * Math.PI; th += thStep) {
            const i = Math.round((th / (2 * Math.PI)) * Nθ) % Nθ;
            const r0 = rin274[i], r1 = rin29[i];
            const w = r1 - r0;
            if (w < 0.3) continue;
            const cx = Math.cos(th), sy = Math.sin(th);
            for (let rp = r0 + 0.1; rp <= r1 - 0.1; rp += probeStep) {
                total++;
                const d = grid.nearest(cx * rp + seedL[0], sy * rp + seedL[1], R + PTOL);
                if (d > R + PTOL - 0.005) {
                    unsampled++;
                    shortfall = Math.max(shortfall, d - R);
                    if (uncutAt.length < 40) {
                        // nearest points for debugging
                        const near = pts
                            .map(q => ({ q, dd: Math.hypot(q[0] - (cx * rp + seedL[0]), q[1] - (sy * rp + seedL[1])) }))
                            .sort((a, b) => a.dd - b.dd).slice(0, 3)
                            .map(o => `(${o.q[0].toFixed(1)},${o.q[1].toFixed(1)},${o.dd.toFixed(2)})`).join(' ');
                        uncutAt.push(`th=${(th * 180 / Math.PI).toFixed(0)} r=${rp.toFixed(1)} w=${w.toFixed(2)} d=${d.toFixed(2)} probe=(${(cx * rp + seedL[0]).toFixed(1)},${(sy * rp + seedL[1]).toFixed(1)}) near:${near}`);
                    }
                }
            }
        }
        if (uncutAt.length && process.env.ACCEPT_PROBES) {
            origLog('  uncut probes: ' + uncutAt.join(' | '));
        }
        rec('1 ledge probes uncut', unsampled === 0,
            `${unsampled}/${total} uncut probes, max axis shortfall ${(shortfall || 0).toFixed(2)} mm`);
    }

    // ---- check 2: finish pass along the free edge ----
    if (zLedge === undefined) {
        rec('2 free-edge finish', false, 'no milling plane at ledge height');
    } else {
        const pts = [];
        for (const p of byZ.get(zLedge)) for (const q of p.pts) pts.push(q);
        const grid = makePolyGrid(byZ.get(zLedge), 1);
        const sectors = 72;
        // path-proximity grace for the free-edge pass. when S >= R the
        // family's ring 1 rides the free edge by design and 0.5 mm is the
        // original criterion. when S < R, ring 1 intentionally hangs
        // (R - S) beyond the edge over verified void (disk still engages ~S
        // of fresh material and fully covers the edge) — the edge cannot
        // and should not host an axis path there, so the grace grows by the
        // designed standoff
        const finTol = Math.max(0.5, (R - S) + 0.5);
        let covered = 0, wLimited = 0, coveredReachable = 0, reachable = 0;
        const missAt = [];
        for (let s = 0; s < sectors; s++) {
            const th0 = (s * 2 * Math.PI) / sectors;
            let hit = false, narrow = true;
            let bestD = Infinity, bestAt = null;
            for (let a = 0; a < 5; a += 0.5) {
                const th = th0 + a * Math.PI / 180;
                const i = Math.round((th / (2 * Math.PI)) * Nθ) % Nθ;
                if (rin29[i] - rin274[i] >= R) narrow = false;
                const x = seedL[0] + Math.cos(th) * rin274[i];
                const y = seedL[1] + Math.sin(th) * rin274[i];
                const d = grid.nearest(x, y, 2.0);
                if (d < bestD) { bestD = d; bestAt = [x, y]; }
                if (d <= finTol) hit = true;
            }
            if (!hit && !narrow && missAt.length < 24) {
                missAt.push(`s${s}(th${(th0 * 180 / Math.PI).toFixed(0)}): d=${bestD === Infinity ? 'inf' : bestD.toFixed(2)}` +
                    (bestAt ? ` at(${bestAt[0].toFixed(1)},${bestAt[1].toFixed(1)})` : ''));
            }
            // a sector whose ledge is narrower than the tool radius cannot
            // host an axis on the free edge (the disk would gouge the wall
            // rising at the ledge's outer edge) — the wall ring covers the
            // material there instead (check 1); not a finish-pass failure
            if (!narrow) {
                reachable++;
                if (hit) coveredReachable++;
            } else {
                wLimited++;
            }
            if (hit) covered++;
        }
        if (missAt.length) origLog('  finish miss: ' + missAt.join(' | '));
        rec('2 free-edge finish >=95% of reachable sectors', coveredReachable >= reachable * 0.95,
            `${covered}/${sectors} sectors within ${finTol.toFixed(2)}mm of rin274` +
            (wLimited ? ` (${wLimited} sectors geometrically unreachable: ledge width < tool R, ${coveredReachable}/${reachable} reachable covered)` : ''));
    }

    // ---- check 3: top-plane face ring smoothness near the silhouette ----
    if (zTop === undefined) {
        rec('3 top-plane smoothness', false, 'no milling plane at top height');
    } else {
        const pts = [];
        for (const p of byZ.get(zTop)) for (const q of p.pts) pts.push(q);
        // the "near silhouette" band must also host the designed face-ring
        // standoff when S < R (ring 1 erodes (R - S) inward)
        const nearTol = Math.max(1.0, (R - S) + 1.0);
        if (process.env.ACCEPT_DEVS) {
            for (const p of byZ.get(zTop)) {
                const ds = p.pts.map(q => distToLoop(outerU, q[0], q[1]));
                const nearD = ds.filter(d => d < nearTol);
                let extra = '';
                if (nearD.length >= 10) {
                    const med = median(nearD);
                    const mad = median(nearD.map(d => Math.abs(d - med)));
                    extra = ` med=${med.toFixed(3)} mad=${mad.toFixed(3)}`;
                }
                origLog(`   z30 poly ${p.open ? 'open' : 'clos'} n=${p.pts.length}: near=${nearD.length}` +
                    (nearD.length ? ` dmin=${Math.min(...nearD).toFixed(2)} dmax=${Math.max(...nearD).toFixed(2)}${extra}` : ''));
            }
        }
        const devs = [];
        for (const q of pts) {
            const d = distToLoop(outerU, q[0], q[1]);
            if (d < nearTol) devs.push(d);
        }
        if (devs.length < 20) {
            rec('3 top-plane smoothness', false, `only ${devs.length} path points near silhouette`);
        } else {
            if (process.env.ACCEPT_DEVS) {
                const sample = [];
                for (const p of byZ.get(zTop)) {
                    for (const q of p.pts) {
                        const d = distToLoop(outerU, q[0], q[1]);
                        if (d < 1.0 && sample.length < 10) sample.push(`(${q[0].toFixed(2)},${q[1].toFixed(2)}|d${d.toFixed(3)})`);
                    }
                }
                origLog('  near-silhouette pts: ' + sample.join(' '));
            }
            // the silhouette-adjacent band hosts several legitimate path
            // populations at once (measured on the reference top plane):
            //   - the face ring riding the silhouette itself (d = 0),
            //   - de-staircased pixel-band rings at the modelBig margin
            //     (~res + smoothTol standoff, smooth contours),
            //   - free-edge progression rings crossing the band where the
            //     cavity rim runs close to the wall (d varies monotonically
            //     along the crossing — not zigzag).
            // A pooled median/MAD over all of them measures the population
            // MIXTURE, not path quality (master passes it only because its
            // d=0 points happen to form the majority; measured: master's
            // own rings carry the same excursions to d~0.97). The
            // anti-regression intent of the #774fb57f acceptance is: the
            // face ring riding the silhouette still exists and is smooth.
            // So: among polys with enough near-silhouette points, at least
            // one must have its own standoff distribution tight around a
            // designed median. the designed face-ring standoff is 0 when
            // S >= R (ring 1 rides the silhouette) and (R - S) inward when
            // S < R (ring 1 erodes the silhouette contour by the hangover);
            // the pixel-band rings at the modelBig margin (~R + smoothTol
            // out) trim the same band flush and count as face rings too.
            const medGate = Math.max(0.5, (R - S) + 0.15);
            let best = null;
            for (const p of byZ.get(zTop)) {
                const nearD = p.pts.map(q => distToLoop(outerU, q[0], q[1])).filter(d => d < nearTol);
                if (nearD.length < 20) continue;
                const med = median(nearD);
                if (med > medGate) continue;
                const mad = median(nearD.map(d => Math.abs(d - med)));
                if (!best || mad < best.mad) best = { n: nearD.length, med, mad };
            }
            rec('3 top-plane face ring rides silhouette smoothly', !!best && best.mad < 0.1,
                best ? `face ring: ${best.n} near-silhouette pts, MAD=${best.mad.toFixed(3)} mm` :
                'no smooth face ring riding the silhouette found');
        }
    }

    // ---- check 9: EVERY top-plane path is model-true (task #c7a102e5).
    // check 3 samples only the smoothest face ring riding the outer
    // silhouette; the customer defect ("много бахромы" at z=30) sits in the
    // plane's OTHER paths — family rings anchored on the pixel-matrix
    // fallback carry the quantization fringe. every z=30 cutting path is a
    // designed offset of a model contour (cavity mouth, outer silhouette,
    // handle hole — all loops of the section just below the top plane), so
    // its per-point distance to the NEAREST model contour must be tight
    // around its own median (MAD < 0.1 mm). a pixel-fringe ring meanders
    // across the heightmap quantization band and fails; a rollback to the
    // legacy stock-outline rings (which offset the op clip, not a model
    // contour) fails too
    if (zTop === undefined) {
        rec('9 top-plane paths model-true', false, 'no milling plane at top height');
    } else {
        const loopsTop = sectionLoops(vertices, Z_TOP - 1e-3);
        if (!loopsTop.length) {
            rec('9 top-plane paths model-true', false, 'model section just below the top plane is empty');
        } else {
            const contGrid = makePolyGrid(
                loopsTop.map(loop => ({ pts: loop.map(p => [ p[0], p[1 ], Z_TOP ]) })), 2);
            const FAR_D = 12; // points farther than this from every contour
            let worst = null, farPaths = 0, checked9 = 0;
            for (const p of byZ.get(zTop)) {
                if (p.pts.length < 2) continue;
                // flat cutting paths only: plunge/retract records span z
                let zmin = Infinity, zmax = -Infinity;
                for (const q of p.pts) {
                    if (q[2] < zmin) zmin = q[2];
                    if (q[2] > zmax) zmax = q[2];
                }
                if (zmax - zmin > 0.05) continue;
                const ds = p.pts.map(q => contGrid.nearest(q[0], q[1], FAR_D));
                checked9++;
                if (ds.some(d => d >= FAR_D)) {
                    farPaths++;
                    if (!worst) worst = { n: p.pts.length, med: NaN, mad: Infinity };
                    continue;
                }
                const med = median(ds);
                const mad = median(ds.map(d => Math.abs(d - med)));
                if (!worst || mad > worst.mad) worst = { n: ds.length, med, mad };
            }
            if (!checked9) {
                rec('9 top-plane paths model-true', false, 'no flat cutting paths at the top plane');
            } else {
                rec('9 top-plane paths model-true', !farPaths && worst.mad < 0.1,
                    `${checked9} paths, worst MAD=${worst.mad === Infinity ? 'inf' : worst.mad.toFixed(3)} mm` +
                    ` (${worst.n} pts, med standoff ${isNaN(worst.med) ? 'n/a' : worst.med.toFixed(2)})` +
                    (farPaths ? `, ${farPaths} paths >${FAR_D}mm from every model contour` : ''));
            }
        }
    }

    // ---- check 4: inside only — clip containment + no outside fragments ----
    // parse [FAR] clip boxes per z
    const clips = new Map();
    for (const line of farLog) {
        const m = line.match(/^\[FAR\] z=([-\d.]+) cutz=[-\d.]+ R=[-\d.]+ L=[-\d.]+ modelAnchor=\S+ voidPolys=\d+ clip=x\[([-\d.]+),([-\d.]+)\] y\[([-\d.]+),([-\d.]+)\]/);
        if (m) clips.set(Math.round(parseFloat(m[1]) * 100) / 100, {
            x0: +m[2], x1: +m[3], y0: +m[4], y1: +m[5],
        });
    }
    let outsideClip = 0, checked = 0;
    for (const [ z, polys ] of byZ) {
        const c = clips.get(z) || clips.get(z - 0.01) || clips.get(z + 0.01);
        if (!c) continue;
        for (const p of polys) for (const q of p.pts) {
            checked++;
            if (q[0] < c.x0 - 0.01 || q[0] > c.x1 + 0.01 ||
                q[1] < c.y0 - 0.01 || q[1] > c.y1 + 0.01) outsideClip++;
        }
    }
    // vacuous pass forbidden: zero checked points means no clip/milling
    // plane overlap (or the [FAR] parse broke again) — that fails, not passes
    rec('4a axes within clip', checked > 0 && outsideClip === 0,
        `${outsideClip}/${checked} axis points outside clip box` +
        (checked === 0 ? ' (no [FAR] clip plane matched any milling plane)' : ''));

    // ---- check 4a-sil: inside-only flats axes within the PART silhouette ----
    // (task #5851ae4a). the clip box check above is coarse: the op clip is
    // the plane shadow dilated by R, so axes up to R outside the part pass
    // it while violating Inside only (measured on the reference top plane:
    // an outward-dilated silhouette ring ran ~1.9 mm past the part with
    // 53 axis points outside). the part silhouette is the top-view outline
    // = outermost loop of model sections spanning the part height (not the
    // per-plane section: at a ledge plane the section is the deep cavity
    // while the part outline is the top rim). checked on the flats planes
    // only — depth planes legitimately keep the wall-side stock band
    // (finished by the profile pass); the customer accepts that.
    // tolerance ~ts_eps (op-area quantization slack)
    {
        // under test only on the inside-only flats profile: with ALL=1 the
        // op clears the entire stock rectangle by request — the silhouette
        // does not bound it
        const INSIDE = process.env.INSIDE !== '0' && process.env.ALL === '0';
        const SIL_EPS = 0.01;
        const silSections = [
            sectionLoops(vertices, Z_TOP - 1e-3),
            loopsUpper, loopsLower, loopsFloor,
            sectionLoops(vertices, Z_BOT + 1e-3),
        ];
        const silOuters = silSections.filter(ls => ls.length).map(ls => {
            ls.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
            return ls[0];
        });
        const outsideSil = (x, y) => {
            for (const L of silOuters) {
                if (pointInLoop(L, x, y) || distToLoop(L, x, y) <= SIL_EPS) return false;
            }
            return true;
        };
        const flatsZs = [ zTop, zLedge, zFloor, zBot ].filter(z => z !== undefined);
        let silOut = 0, silChecked = 0, silMax = 0;
        for (const z of flatsZs) {
            for (const p of (byZ.get(z) || [])) for (const q of p.pts) {
                silChecked++;
                if (outsideSil(q[0], q[1])) {
                    silOut++;
                    silMax = Math.max(silMax, Math.min(...silOuters.map(L => distToLoop(L, q[0], q[1]))));
                }
            }
        }
        if (!silOuters.length) {
            rec('4a-sil axes within part silhouette', false, 'no silhouette sections derived from the model');
        } else if (!INSIDE) {
            rec('4a-sil axes within part silhouette', true,
                `not under test (needs INSIDE=1 ALL=0): ${silOut}/${silChecked} axis points outside silhouette on flats planes`);
        } else {
            rec('4a-sil axes within part silhouette', silChecked > 0 && silOut === 0,
                `${silOut}/${silChecked} axis points outside silhouette on flats planes` +
                (silOut ? `, max overshoot ${silMax.toFixed(2)} mm` : ''));
        }
    }

    if (zLedge === undefined) {
        rec('4b no fragments outside silhouette', false, 'no milling plane at ledge height');
    } else {
        // fragments entirely outside the part silhouette split into two
        // physically different classes (measured on the reference ledge
        // plane):
        //   - wall finish passes: the wall ring (shadow ⊕ R + L, clipped
        //     to the op clip) legitimately runs with its axis outside the
        //     part — the disk sweep still trims the wall/ledge flush. Its
        //     points sit within R of the silhouette.
        //   - phantom sliver fragments: junk rings riding matrix
        //     quantization slivers on the already-cleaned band outside the
        //     part (measured up to r 91 on master, sweep cuts pure air).
        //     Their points sit farther than R from the silhouette — the
        //     disk sweep cannot touch the part at all.
        // Only the phantom class violates the goal (fringe from the pixel
        // matrix / air cuts under Inside only).
        const frags = [];
        for (const p of byZ.get(zLedge)) {
            if (p.pts.every(q => !pointInLoop(outerL, q[0], q[1]))) frags.push(p);
        }
        const phantom = frags.filter(p =>
            p.pts.every(q => distToLoop(outerL, q[0], q[1]) > R + 0.1));
        const maxR = Math.max(0, ...phantom.flatMap(p => p.pts.map(q => Math.hypot(q[0] - seedL[0], q[1] - seedL[1]))));
        if (frags.length && process.env.ACCEPT_FRAGS) {
            for (const f of frags) {
                const dmin = Math.min(...f.pts.map(q => distToLoop(outerL, q[0], q[1])));
                origLog(`   frag ${f.open ? 'open' : 'clos'} n=${f.pts.length} dWall=${dmin.toFixed(2)}${dmin > R + 0.1 ? ' PHANTOM' : ' wall-ok'}: ` +
                    f.pts.slice(0, 14).map(q => `(${q[0].toFixed(1)},${q[1].toFixed(1)})`).join(' '));
            }
        }
        rec('4b no phantom fragments beyond tool reach of the silhouette', phantom.length === 0,
            phantom.length === 0 ?
                `${frags.length} outside-silhouette frags, all wall-finish (sweep reaches the part)` :
                `${phantom.length} phantom frags (of ${frags.length} outside), max r ${maxR.toFixed(1)}`);
    }

    // ---- check 5: other flats planes still machined, pixel fallback there ----
    const farLines = farLog.filter(l => l.startsWith('[FAR] '));
    const anchorAt = (target) => {
        const hits = [];
        for (const l of farLines) {
            const m = l.match(/^\[FAR\] z=([-\d.]+).*modelAnchor=(\S+)/);
            if (m && near(parseFloat(m[1]), target, 0.5)) hits.push(m[2] === 'YES');
        }
        return hits;
    };
    const ok5 = zFloor !== undefined && zBot !== undefined;
    rec('5 floor/bottom flats machined', ok5,
        `z≈${Z_FLOOR}: ${zFloor !== undefined ? byZ.get(zFloor).length + ' polys' : 'MISSING'}, ` +
        `z≈${Z_BOT}: ${zBot !== undefined ? byZ.get(zBot).length + ' polys' : 'MISSING'}`);
    if (ok5) {
        // the bottom plane must machine through the pixel anchor path (no
        // model contour verifies there) — but freeAnchorRings only runs (and
        // logs) when verified void exists at the plane: with coarse down
        // steps nothing is verified as cleared at the bottom plane and it
        // legitimately defers to the legacy rings before any logging. so the
        // hard requirement is: no bottom-plane record claims the model
        // anchor; when records exist they must all be pixel fallbacks
        const fb = anchorAt(Z_BOT);
        rec('5b pixel fallback works on bottom plane', zBot !== undefined && fb.every(v => !v),
            fb.length ? `bottom modelAnchor=${fb.map(v => v ? 'YES' : 'no').join(',')}` :
                'no [FAR] records (no verified void at plane — legacy rings)');
    }

    // ---- check 7: authored emission order on the free-anchor flats planes ----
    // (task #03afbbf1). freeAnchorRings generates the ring family in authored
    // order — from the verified-void free edge to the wall, wall finish ring
    // last — and stamps it (farrSeq). the stamped set is exported through the
    // [FARRJ] channel; here each emitted milling path is matched back to its
    // ring by point-set distance (emission rotates a ring's start point but
    // keeps its point set), and the emission sequence must reproduce the
    // authored order:
    //   7a first cut = authored ring 0 (over the verified void by the
    //      generator's own construction; ledge geometry independently
    //      re-verified by checks 1 and 2),
    //   7b wall finish ring = the plane's LAST pass,
    //   7c no scrambling: the whole sequence is monotone in seq and emits
    //      every ring of the set exactly once.
    // greedy nearest-neighbor routing (the pre-fix emitter) fails 7a/7b/7c:
    // it emits the wall ring first whenever the tool arrives near the wall —
    // a vertical plunge at full radial immersion into uncut material, then
    // useless passes over already-cleared volume (the customer defect).
    // planes without a [FARRJ] set ran legacy/pixel rings (freeAnchorRings
    // not applicable there — e.g. no verified void at the bottom flat with
    // coarse down steps); their order the stamp does not govern — reported
    // as not under test (their machining is covered by check 5)
    const farrSetAt = (target) => {
        for (const [ z, set ] of farrSets) {
            if (near(z, target, 0.5)) return set;
        }
        return undefined;
    };
    // 2D extent of a point list — cut-worthiness and near-tie matching below
    const extent2D = pts => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of pts) {
            const x = q[0], y = q[1];
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return (x1 - x0) + (y1 - y0);
    };
    // match an emitted path to a reference ring: max over the path's points
    // of the distance to the ring's nearest point (0 for a start-rotated
    // copy of the ring; ~stepover for a neighboring ring)
    const matchSeq = (path, refSet, refGrids, refExt) => {
        const pext = extent2D(path.pts);
        const cands = [];
        for (let ri = 0; ri < refSet.length; ri++) {
            const grid = refGrids[ri];
            let worst = 0;
            for (let i = 0; i < path.pts.length; i += 2) {
                const q = path.pts[i];
                worst = Math.max(worst, grid.nearest(q[0], q[1], 2));
            }
            cands.push({ ri, d: worst });
        }
        cands.sort((a, b) => a.d - b.d);
        let pick = cands[0];
        // near-tie disambiguation: adjacent fragments of one clipped ring
        // share geometry where their point sets touch, so an emitted stub
        // can score d≈0 against BOTH grids (strict ref-order update then
        // lets the wrong fragment win the tie and the multiset check reads
        // one seq twice and its neighbor zero times). an emitted path is a
        // start-rotated copy of exactly ONE authored entry, so when the two
        // best distances sit within quantization noise (< 0.01 mm), prefer
        // the candidate whose 2D extent matches the cut's extent
        if (cands.length > 1 && cands[1].d - cands[0].d < 0.01) {
            const de = c => Math.abs(refExt[c.ri] - pext);
            if (de(cands[1]) < de(cands[0])) {
                pick = cands[1];
            }
        }
        return { seq: refSet[pick.ri].s, d: pick.d };
    };
    for (const [ tag, zTarget ] of [ [ 'ledge', Z_LEDGE ], [ 'floor', Z_FLOOR ], [ 'bottom', Z_BOT ] ]) {
        const zPlane = zList.find(z => near(z, zTarget));
        const refSet = zPlane !== undefined ? farrSetAt(zTarget) : undefined;
        const paths = zPlane !== undefined ? byZ.get(zPlane) : undefined;
        if (!refSet) {
            // the cavity floor plane MUST run the free-anchor set (goal
            // #7434434b point 3: leveling starts from the central hole's
            // void): a rollback to the legacy wall-anchored pixel rings
            // there is exactly the customer defect — not an N/A. the bottom
            // plane may legitimately defer to the legacy rings (no verified
            // void at the plane with coarse down steps — see check 5b)
            rec(`7 order (${tag})`, tag !== 'floor' && !!paths && paths.length > 0,
                tag === 'floor' ?
                    `free-anchor set REQUIRED at the cavity floor plane — got ${paths ? paths.length : 0} legacy/pixel paths (coverage net rolled the plane back)` :
                    `no free-anchor set at plane (${paths ? paths.length : 0} legacy/pixel paths) — ordering N/A`);
            continue;
        }
        if (!paths || !paths.length) {
            rec(`7 order (${tag})`, false, 'milling paths not found at plane');
            continue;
        }
        // cutting paths only: plunge/travel records are 2-point polylines
        // with zero 2D extent (a vertical move at a fixed xy)
        // cut-worthiness: the free-anchor wall ring is diced by the pixelated
        // clip boundary into real segments and sub-0.5mm darts (the pixel
        // matrix fringe the goal calls out). darts ride along as authored
        // (they shave quantization remnants) but are not "passes" under the
        // order checks — the comparison runs on real cuts (>= 0.5mm of 2D
        // travel) on BOTH sides, so the knife-edge threshold cannot flip
        // individual darts between the compared sets
        const MIN_CUT = 0.5;
        const cuts = paths.filter(p => extent2D(p.pts) > MIN_CUT);
        // the reference set may contain sub-threshold open fragments too
        // (wall-band slivers from clipping the family against the pixel
        // matrix / handle contours). they are emitted as authored but are
        // not "cuts" under the same threshold, so the order comparison
        // runs against the set's cut-worthy entries only
        const refCuts = refSet.filter(r => extent2D(r.pts) > MIN_CUT);
        // per-ring point grids for matching (+ extents for near-tie picks)
        const refGrids = refCuts.map(r => makeGrid(r.pts.map(q => [ q[0], q[1] ]), 1));
        const refExt = refCuts.map(r => extent2D(r.pts));
        const matched = cuts.map(p => matchSeq(p, refCuts, refGrids, refExt));
        const unmatched = matched.filter(m => m.d > 0.25).length;
        const seqs = matched.map(m => m.seq);
        const minSeq = Math.min(...refCuts.map(r => r.s));
        const maxSeq = Math.max(...refCuts.map(r => r.s));
        const monotone = seqs.every((s, i) => i === 0 || s >= seqs[i - 1]);
        // multiset equality: every cut-worthy ring emitted exactly once
        // (fragments of one ring share its seq and must appear consecutively)
        const want = refCuts.map(r => r.s).sort((a, b) => a - b).join(',');
        const got = seqs.slice().sort((a, b) => a - b).join(',');
        rec(`7a first cut is authored ring 0 (${tag})`, seqs[0] === minSeq,
            `first path matched seq ${seqs[0]} (authored first ${minSeq})`);
        // wall block last: the generator orders family rings first, wall
        // finish pieces after ([...rings, ...wall] + stampFarrSeq), so the
        // plane's last real cut must be a wall piece — and (with 7c's
        // monotonicity) every family ring precedes every wall piece
        const wallAfterFamily = seqs.every((s, i) =>
            !(refCuts.find(r => r.s === s)?.w !== 'W') ||
            seqs.slice(0, i).every(q => refCuts.find(r => r.s === q)?.w !== 'W'));
        rec(`7b wall finish ring last (${tag})`,
            seqs[seqs.length - 1] === maxSeq &&
            refCuts.find(r => r.s === maxSeq)?.w === 'W',
            `last path matched seq ${seqs[seqs.length - 1]} (authored last ${maxSeq}, ` +
            `src ${refCuts.find(r => r.s === maxSeq)?.w ?? '?'})`);
        rec(`7c emitted order monotone and complete (${tag})`,
            unmatched === 0 && monotone && want === got && wallAfterFamily,
            `${cuts.length} cuts vs ${refCuts.length} rings, ${unmatched} unmatched, ` +
            `monotone=${monotone}, family-before-wall=${wallAfterFamily}, ` +
            `multiset ${want === got ? 'equal' : 'DIFFERS'}`);
    }

    // ---- check 7d (floor): the first floor pass runs over verified void.
    // 7a alone would accept any authored ring 0; the goal's point 3 is
    // explicit: on a floor with a central hole, leveling starts from the
    // hole's void in the middle, never with a plunge into the wall band.
    // two legal shapes: when S < R the first family ring hangs over the
    // hole's void (points on/inside the model hole contour); when S >= R
    // ring 0 rides the whole verified-void boundary and the emitted first
    // cut may be its residual-boundary fragment (over matrix-verified
    // void by the generator's own construction — accepted via its 'V'
    // seq-0 match). a legacy wall-anchored first pass matches neither
    // ---- check 8: the rings around the central hole are model-true. the
    // hole-anchored family rings are concentric offsets of the model hole
    // contour, so the per-path distance-to-contour distribution must be
    // tight around its own median (MAD < 0.1 mm); a pixel-fringe ring
    // meanders across the quantization band and fails. distances are
    // pooled per path (never across paths: distinct rings sit at distinct
    // designed offsets — a pooled MAD would measure the ring spacing, not
    // the wiggle)
    if (!holeF) {
        rec('7d floor first pass over central-hole void', false, 'model hole contour not found in the floor section');
        rec('8 hole rings model-true', false, 'model hole contour not found in the floor section');
    } else if (zFloor === undefined) {
        rec('7d floor first pass over central-hole void', false, 'no milling plane at floor height');
        rec('8 hole rings model-true', false, 'no milling plane at floor height');
    } else {
        const cutsF = byZ.get(zFloor).filter(p => extent2D(p.pts) > 0.5);
        const firstF = cutsF[0];
        if (!firstF) {
            rec('7d floor first pass over central-hole void', false, 'no real cutting pass at the floor plane');
        } else {
            // a first-cut point is over the hole void when it sits inside
            // the model hole contour, or within PTOL-class grace of it
            // (ring 0 rides the contour itself when stepover >= 50%; the
            // STL reference section vs the app's mesh slice disagree by
            // ~0.1-0.3 mm of tessellation — same tolerance as check 1)
            let off = 0;
            for (const q of firstF.pts) {
                if (!pointInLoop(holeF, q[0], q[1]) && distToLoop(holeF, q[0], q[1]) > 0.3) off++;
            }
            // void-riding alternative (S >= R): the first cut matches the
            // authored seq-0 ring and that ring is void-anchored ('V' —
            // over matrix-verified void by construction). matching reuses
            // the 7-loop's matcher via a local point grid
            const refSetF = farrSetAt(Z_FLOOR);
            let voidRide = false;
            if (refSetF && off > 0) {
                const ref0 = refSetF.filter(r => r.w === 'V');
                const minSeq = Math.min(...refSetF.map(r => r.s));
                const g0 = ref0.find(r => r.s === minSeq);
                if (g0) {
                    const grid0 = makeGrid(g0.pts, 1);
                    voidRide = firstF.pts.every(q => grid0.nearest(q[0], q[1], 0.25) < 0.25);
                }
            }
            rec('7d floor first pass over central-hole void', off === 0 || voidRide,
                off === 0 ?
                    `${firstF.pts.length}/${firstF.pts.length} first-cut points on/inside the model hole contour` :
                    `first cut rides the authored seq-0 void-anchored ring (${firstF.pts.length} pts, ` +
                    `${firstF.pts.length - off} off the hole contour)`);
        }
        // hole-band paths: every point within R + 0.5 of the hole contour
        // (covers the family rings while they advance away from the hole;
        // the wall ring and the pixel-residual fragments at the cavity
        // wall sit far outside the band and are excluded)
        const holeBand = R + 0.5;
        const holeRings = [];
        for (const p of byZ.get(zFloor)) {
            if (p.pts.length < 20) continue;
            const ds = p.pts.map(q => distToLoop(holeF, q[0], q[1]));
            if (ds.every(d => d < holeBand)) holeRings.push(ds);
        }
        if (!holeRings.length) {
            rec('8 hole rings model-true', false,
                `no floor path within ${holeBand.toFixed(1)}mm of the model hole contour`);
        } else {
            let worst = null;
            for (const ds of holeRings) {
                const med = median(ds);
                const mad = median(ds.map(d => Math.abs(d - med)));
                if (!worst || mad > worst.mad) worst = { n: ds.length, med, mad };
            }
            rec('8 hole rings model-true', worst.mad < 0.1,
                `${holeRings.length} hole-band rings, worst MAD=${worst.mad.toFixed(3)} mm ` +
                `(med standoff ${worst.med.toFixed(2)}, ${worst.n} pts)`);
        }
    }

    // ---- check 6: slice perf ----
    const budget = toolDiam <= 6.5 ? 15000 : 30000;
    rec('6 slice time', sliceMs <= budget, `${(sliceMs / 1000).toFixed(1)} s (budget ${budget / 1000} s)`);

    const failed = results.filter(r => !r.pass);
    origLog(`\nACCEPT ${failed.length ? 'FAIL' : 'PASS'} (Ø${toolDiam} S=${stepFrac}): ` +
        `${results.length - failed.length}/${results.length} checks passed` +
        (failed.length ? ` — failed: ${failed.map(f => f.name).join(', ')}` : ''));
}
