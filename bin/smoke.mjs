#!/usr/bin/env node
/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/*
 * Headless app-load smoke test for kiri:moto / mesh:tool / void:form.
 *
 * For each app it:
 *   - starts (or reuses) the gs-app-server on a scratch port
 *   - launches headless Chrome (system binary, CDP over websocket)
 *   - waits for load + async init (curtain lifted), up to --timeout seconds
 *   - fails on: uncaught ReferenceError/TypeError/SyntaxError,
 *     unfinished init (curtain still visible), 404s on critical resources
 *
 * Usage:
 *   npm run smoke                       # all apps, fresh server on port 8099
 *   node bin/smoke.mjs --apps=kiri      # subset: kiri,mesh,void
 *   node bin/smoke.mjs --port=8099      # server port (reused if already serving)
 *   node bin/smoke.mjs --chrome=/path   # chrome binary override
 *   node bin/smoke.mjs --timeout=20     # per-app init timeout (seconds)
 *   node bin/smoke.mjs --verbose        # echo every console message / request
 *
 * Env overrides: SMOKE_PORT, SMOKE_APPS, SMOKE_TIMEOUT, SMOKE_CHROME.
 * Requires zero extra dependencies (uses the repo's `ws`).
 * This does not replace manual feature verification -- it only catches
 * load-time breakage (ref issue #510d74e9).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_RUN = path.join(ROOT, 'node_modules', '@gridspace', 'app-server', 'app-server-run.js');

const APPS = {
    kiri: '/kiri/',
    mesh: '/mesh/',
    void: '/void/',
};

// resources whose failure to load means the app cannot work
const CRITICAL_URL = /\/lib\/|\.js($|\?)|\.wasm($|\?)|\.json($|\?)/i;

const FATAL_EXC = /\b(ReferenceError|TypeError|SyntaxError|EvalError)\b/;

// ---------------------------------------------------------------- options --

function parse_args(argv) {
    const opt = {};
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/i);
        if (m) opt[m[1]] = m[2] ?? true;
        else (opt.apps ||= []).push(arg);
    }
    return {
        port: Number(opt.port || process.env.SMOKE_PORT || 8099),
        apps: String(opt.apps || process.env.SMOKE_APPS ||
            (opt.apps ? opt.apps.join(',') : '') || 'kiri,mesh,void')
            .split(',').map(s => s.trim()).filter(Boolean),
        timeout: Number(opt.timeout || process.env.SMOKE_TIMEOUT || 20) * 1000,
        chrome: opt.chrome || process.env.SMOKE_CHROME || process.env.CHROME_BIN || '',
        verbose: !!opt.verbose,
    };
}

const OPT = parse_args(process.argv);
const LOG = (...a) => console.log(...a);
const VLOG = (...a) => { if (OPT.verbose) console.log('  |', ...a); };

// ---------------------------------------------------------------- chrome ---

function find_chrome() {
    if (OPT.chrome) {
        if (!fs.existsSync(OPT.chrome)) throw new Error(`chrome not found: ${OPT.chrome}`);
        return OPT.chrome;
    }
    const candidates = [];
    if (process.platform === 'darwin') {
        for (const home of ['/Applications', path.join(os.homedir(), 'Applications')]) {
            candidates.push(
                `${home}/Google Chrome.app/Contents/MacOS/Google Chrome`,
                `${home}/Chromium.app/Contents/MacOS/Chromium`,
                `${home}/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
                `${home}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
            );
        }
    } else if (process.platform === 'win32') {
        for (const base of ['C:\\Program Files', 'C:\\Program Files (x86)', process.env.LOCALAPPDATA || '']) {
            candidates.push(
                `${base}\\Google\\Chrome\\Application\\chrome.exe`,
                `${base}\\Chromium\\Application\\chrome.exe`,
                `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
            );
        }
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome-beta',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/msedge',
        );
    }
    for (const cand of candidates) {
        if (fs.existsSync(cand)) return cand;
    }
    // last resort: PATH lookup
    const which = spawn('which', ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], { stdio: 'pipe' });
    return new Promise((resolve, reject) => {
        let out = '';
        which.stdout.on('data', d => out += d);
        which.on('close', code => {
            const found = out.split('\n').map(s => s.trim()).find(Boolean);
            if (code === 0 && found) resolve(found);
            else reject(new Error(
                'no chrome/chromium binary found; install Chrome or pass --chrome=/path/to/chrome'));
        });
    });
}

// ---------------------------------------------------------------- server ---

function http_status(url) {
    return new Promise(resolve => {
        const req = http.get(url, { timeout: 2000 }, res => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
    });
}

function port_busy(port) {
    return new Promise(resolve => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
    });
}

async function wait_server(port, proc, deadline_ms) {
    const end = Date.now() + deadline_ms;
    while (Date.now() < end) {
        if (proc && proc.exitCode !== null) {
            throw new Error(`server exited early (code ${proc.exitCode})`);
        }
        if (await http_status(`http://127.0.0.1:${port}/kiri/`) === 200) return;
        await sleep(250);
    }
    throw new Error(`server not ready on port ${port} within ${deadline_ms}ms`);
}

async function ensure_server(port) {
    // reuse an already-running server only if it serves all requested apps
    if (await port_busy(port)) {
        const ok = [];
        for (const [name, route] of Object.entries(APPS)) {
            if (!OPT.apps.includes(name)) continue;
            if (await http_status(`http://127.0.0.1:${port}${route}`) === 200) ok.push(name);
        }
        if (ok.length === OPT.apps.length) {
            LOG(`reusing existing server on port ${port}`);
            return { proc: null, port };
        }
        throw new Error(`port ${port} is busy with a server that does not serve ${OPT.apps.join(',')}`);
    }
    const proc = spawn(process.execPath, [SERVER_RUN, '--debug', '--single', '--port', String(port)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', d => VLOG('[server]', String(d).trim()));
    proc.stderr.on('data', d => VLOG('[server!]', String(d).trim()));
    await wait_server(port, proc, 30000);
    return { proc, port };
}

// -------------------------------------------------------------------- cdp --

class CDP {
    constructor(ws_url) {
        this.ws = null;
        this.ws_url = ws_url;
        this.mid = 0;
        this.pending = new Map();
        this.listeners = [];
    }

    connect() {
        return new Promise(async (resolve, reject) => {
            let WS;
            try {
                WS = (await import('ws')).default;
            } catch (e) {
                return reject(new Error('cannot load `ws` module -- run npm install first'));
            }
            const ws = this.ws = new WS(this.ws_url, { maxPayload: 256 * 1024 * 1024 });
            ws.on('open', resolve);
            ws.on('error', reject);
            ws.on('message', data => {
                const msg = JSON.parse(data);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve: res, reject: rej } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
                } else if (msg.method) {
                    for (const fn of this.listeners) fn(msg);
                }
            });
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.mid;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
    }

    on(fn) {
        this.listeners.push(fn);
    }

    close() {
        try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
    }
}

// delay helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wait_for(ws_send_fn, predicate, timeout_ms, poll_ms = 250) {
    const end = Date.now() + timeout_ms;
    while (Date.now() < end) {
        const value = await ws_send_fn();
        if (predicate(value)) return value;
        await sleep(poll_ms);
    }
    return null;
}

// ------------------------------------------------------------- app checks --

async function check_app(chrome_bin, port, name, route, profile_dir) {
    const url = `http://127.0.0.1:${port}${route}`;
    const result = { app: name, ok: true, errors: [], warnings: [], console: [] };

    const args = [
        '--headless=new',
        '--disable-gpu',
        // software WebGL: the apps need a WebGL context; provide swiftshader
        // since headless has no GPU (also required in CI containers)
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--hide-scrollbars',
        '--window-size=1600,900',
        `--user-data-dir=${profile_dir}`,
        '--remote-debugging-port=0',
        'about:blank',
    ];
    const chrome = spawn(chrome_bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // discover the devtools websocket endpoint from stderr
    const ws_url = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('chrome did not expose a devtools endpoint')), 15000);
        chrome.stderr.on('data', d => {
            buf += String(d);
            const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
            VLOG('[chrome]', String(d).trim());
        });
        chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`chrome exited early (code ${code})`)); });
    });

    const cdp = new CDP(ws_url);
    try {
        await cdp.connect();

        const net_status = [];   // { url, status }
        const exceptions = [];   // { text, description }
        const console_errors = [];

        cdp.on(msg => {
            if (!msg.sessionId) return;
            const { method, params } = msg;
            if (method === 'Network.responseReceived') {
                const { url: rurl, status } = params.response;
                net_status.push({ url: rurl, status });
                VLOG(`[net ${status}] ${rurl}`);
            } else if (method === 'Network.loadingFailed') {
                if (params.errorText && !/net::ERR_ABORTED/.test(params.errorText)) {
                    net_status.push({ url: `(failed) ${params.errorText}`, status: 0 });
                }
            } else if (method === 'Runtime.exceptionThrown') {
                const ex = params.exceptionDetails;
                const desc = ex.exception?.description || ex.text || 'unknown';
                exceptions.push({ text: ex.text, description: desc });
                console.log(`    [exception] ${desc.split('\n')[0]}`);
            } else if (method === 'Runtime.consoleAPICalled') {
                const text = (params.args || []).map(a => a.value?.toString() || a.description || '').join(' ');
                if (text) {
                    result.console.push(text);
                    VLOG(`[console.${params.type}] ${text}`);
                    if (params.type === 'error') console_errors.push(text);
                }
            } else if (method === 'Log.entryAdded') {
                const { level, text } = params.entry;
                if (level === 'error') {
                    console_errors.push(text);
                    VLOG(`[log.error] ${text}`);
                }
            }
        });

        const session = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: session, flatten: true });
        const S = (method, params) => cdp.send(method, params, sessionId);

        await S('Page.enable');
        await S('Runtime.enable');
        await S('Network.enable');
        await S('Log.enable');

        await S('Page.navigate', { url });

        // wait for async init: page fully loaded (readyState complete) and
        // curtain lifted (display:none / opacity:0) or gone from the DOM
        const curtain_check = `(() => {
            const state = {
                url: location.href,
                ready: document.readyState,
                present: false,
                hidden: false,
            };
            const el = document.getElementById('curtain');
            if (!el) return JSON.stringify(state);
            state.present = true;
            const cs = getComputedStyle(el);
            state.hidden = cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0;
            state.text = (el.textContent || '').trim().slice(0, 60);
            return JSON.stringify(state);
        })()`;

        let last_state = null;
        const lifted = await wait_for(
            async () => {
                try {
                    const ev = await S('Runtime.evaluate', { expression: curtain_check, returnByValue: true });
                    if (ev.exceptionDetails) {
                        VLOG('[evaluate!]', JSON.stringify(ev.exceptionDetails).slice(0, 200));
                        return { url: '', ready: 'x', present: true, hidden: false };
                    }
                    last_state = JSON.parse(ev.result.value || '{}');
                    return last_state;
                } catch (e) {
                    VLOG('[evaluate!]', e.message);
                    return { url: '', ready: 'x', present: true, hidden: false, text: `evaluate failed: ${e.message}` };
                }
            },
            state => state.url === url && state.ready === 'complete' && (state.hidden || !state.present),
            OPT.timeout,
            300,
        );

        result.curtain = lifted;
        // success = page loaded + curtain lifted/gone (wait_for returns non-null only on predicate match)
        if (!lifted) {
            result.ok = false;
            const st = last_state ? ` (last state: ${JSON.stringify(last_state)})` : ' (no page state)';
            result.errors.push(`init did not complete within ${OPT.timeout / 1000}s${st}`);
            // diagnostic dump
            try {
                const dump = await S('Runtime.evaluate', {
                    expression: `document.documentElement.outerHTML.slice(0, 600)`,
                    returnByValue: true,
                });
                VLOG('[dom]', String(dump.result?.value).replace(/\s+/g, ' ').slice(0, 600));
                const frames = await S('Runtime.evaluate', {
                    expression: `JSON.stringify({ids: [...document.querySelectorAll('[id]')].slice(0,25).map(e => e.id), bodykids: document.body.childElementCount, ready: document.readyState})`,
                    returnByValue: true,
                });
                VLOG('[dominfo]', String(frames.result?.value));
            } catch (e) { VLOG('[dom dump failed]', e.message); }
        }

        // uncaught fatal exceptions
        for (const ex of exceptions) {
            if (FATAL_EXC.test(ex.description)) {
                result.ok = false;
                result.errors.push(`uncaught ${ex.description.split('\n')[0]}`);
            } else {
                result.warnings.push(`uncaught: ${ex.description.split('\n')[0]}`);
            }
        }

        // 404 / failed loads on critical resources
        const bad_net = net_status.filter(n =>
            n.status >= 400 && CRITICAL_URL.test(n.url));
        if (bad_net.length) {
            result.ok = false;
            for (const n of bad_net) {
                result.errors.push(`critical resource ${n.status === 0 ? 'failed to load' : `HTTP ${n.status}`}: ${n.url}`);
            }
        }
        const other_bad = net_status.filter(n => n.status >= 400 && !CRITICAL_URL.test(n.url));
        for (const n of other_bad) result.warnings.push(`non-critical HTTP ${n.status}: ${n.url}`);

        // keep a tail of console output for the report
        result.console_tail = result.console.slice(-5);

        await S('Target.closeTarget', { targetId: session });
    } catch (e) {
        result.ok = false;
        result.errors.push(`harness error: ${e.message}`);
    } finally {
        cdp.close();
        try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }

    return result;
}

// ------------------------------------------------------------------ main ---

async function main() {
    LOG(`smoke: apps=[${OPT.apps.join(',')}] port=${OPT.timeout / 1000}s/${OPT.port} chrome discovery...`);
    const chrome_bin = await find_chrome();
    LOG(`smoke: chrome = ${chrome_bin}`);

    const { proc: server_proc, port } = await ensure_server(OPT.port);
    let failures = 0;

    try {
        for (const name of OPT.apps) {
            const route = APPS[name];
            if (!route) {
                LOG(`smoke: unknown app "${name}" (known: ${Object.keys(APPS).join(', ')})`);
                failures++;
                continue;
            }
            LOG(`smoke: [${name}] loading ${route}`);
            const profile = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${name}-`));
            const res = await check_app(chrome_bin, port, name, route, profile);
            for (let tries = 0; tries < 5; tries++) {
                try {
                    fs.rmSync(profile, { recursive: true, force: true });
                    break;
                } catch (e) {
                    await sleep(500); // chrome may still be flushing the profile
                }
            }
            if (res.ok) {
                LOG(`smoke: [${name}] PASS` +
                    (res.curtain?.present ? ' (curtain lifted)' : ' (curtain gone)'));
            } else {
                LOG(`smoke: [${name}] FAIL`);
                failures++;
            }
            for (const e of res.errors) LOG(`    error: ${e}`);
            for (const w of res.warnings) LOG(`    warn : ${w}`);
            if (res.console_tail?.length) LOG(`    console tail: ${res.console_tail.join(' | ').slice(0, 300)}`);
        }
    } finally {
        if (server_proc) {
            server_proc.kill('SIGTERM');
        }
    }

    if (failures) {
        LOG(`smoke: ${failures} app(s) FAILED`);
        process.exit(1);
    }
    LOG('smoke: all apps passed');
}

main().catch(e => {
    console.error('smoke: fatal:', e.message);
    process.exit(2);
});
