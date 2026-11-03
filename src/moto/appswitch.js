/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/**
 * Shared cross-app switcher widget.
 *
 * Renders a small logo dropdown that navigates (same window) between the
 * three grid-apps: kiri:moto, mesh:tool and void:form. Navigation uses plain
 * anchor hrefs so it works in Electron (app-el.js whitelists /kiri /mesh
 * /void in its will-navigate handler) as well as in a normal browser.
 *
 * Styling is self-injected and uses the shared palette tokens from
 * /moto/palette.css (loaded by all three app shells).
 */

const APPS = [
    { id: 'kiri', name: 'Kiri:Moto', path: '/kiri/', desc: 'CNC / FDM / SLA slicer' },
    { id: 'mesh', name: 'Mesh:Tool', path: '/mesh/', desc: 'mesh editor and repair' },
    { id: 'void', name: 'Void:Form', path: '/void/', desc: 'parametric CAD' }
];

const STYLE_ID = 'appswitch-style';

const CSS = `
.appswitch {
    position: relative;
    display: flex;
    align-items: stretch;
    user-select: none;
}

.appswitch-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 4px 10px;
    margin: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    white-space: nowrap;
}

.appswitch:hover .appswitch-btn {
    border-color: var(--appname-blue, #5a9fd4);
    background-color: var(--menu-hover-bg, rgba(128,128,128,0.25));
}

.appswitch-logo {
    display: flex;
    align-items: center;
    color: var(--appname-blue, #5a9fd4);
}

.appswitch-caret {
    font-size: 10px;
    opacity: 0.6;
}

.appswitch-menu {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 9000;
    padding-top: 3px;
    text-transform: none;
}

.appswitch:hover .appswitch-menu {
    display: flex;
}

.appswitch-panel {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 180px;
    border: 1px solid var(--border-gray, rgba(128,128,128,0.5));
    border-radius: 6px;
    background: var(--menubar-back, #282828);
    color: var(--menubar-fore, #fafafa);
    padding: 4px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
}

.appswitch-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 10px;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
}

.appswitch-item:hover {
    border-color: var(--appname-blue, #5a9fd4);
    background-color: var(--menu-hover-bg, rgba(128,128,128,0.25));
}

.appswitch-item.current {
    background-color: var(--menu-active-bg, rgba(90,159,212,0.4));
    cursor: default;
}

.appswitch-app {
    font-weight: bold;
}

.appswitch-desc {
    font-size: 11px;
    opacity: 0.7;
}
`;

function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

/** identify current app from <html data-app> or the url path */
export function currentApp() {
    const attr = document.documentElement.getAttribute('data-app');
    if (APPS.find(a => a.id === attr)) {
        return attr;
    }
    const path = location.pathname;
    for (const a of APPS) {
        if (path.startsWith(a.path)) {
            return a.id;
        }
    }
    return null;
}

function logoSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.2 6.8 3.8L12 11.8 5.2 8 12 4.2zM5 9.7l6 3.4v6.7l-6-3.3V9.7zm8 10.1v-6.7l6-3.4v6.8l-6 3.3z');
    svg.appendChild(path);
    return svg;
}

function buildWidget(opts = {}) {
    const current = currentApp();
    const widget = document.createElement('div');
    widget.className = 'appswitch';
    widget.title = 'grid.space apps';

    const btn = document.createElement('div');
    btn.className = 'appswitch-btn';
    const logo = document.createElement('span');
    logo.className = 'appswitch-logo';
    logo.appendChild(logoSvg());
    btn.appendChild(logo);
    if (opts.showName) {
        const app = APPS.find(a => a.id === current);
        const name = document.createElement('span');
        name.className = 'appswitch-name';
        name.textContent = app ? app.name : 'grid.space';
        btn.appendChild(name);
    }
    const caret = document.createElement('span');
    caret.className = 'appswitch-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);

    const menu = document.createElement('div');
    menu.className = 'appswitch-menu';
    const panel = document.createElement('div');
    panel.className = 'appswitch-panel';
    for (const app of APPS) {
        const item = document.createElement(app.id === current ? 'div' : 'a');
        item.className = 'appswitch-item' + (app.id === current ? ' current' : '');
        if (app.id !== current) {
            // plain same-window navigation; Electron whitelists these paths
            item.href = app.path;
        }
        const nm = document.createElement('span');
        nm.className = 'appswitch-app';
        nm.textContent = app.name;
        const ds = document.createElement('span');
        ds.className = 'appswitch-desc';
        ds.textContent = app.desc;
        item.appendChild(nm);
        item.appendChild(ds);
        panel.appendChild(item);
    }
    menu.appendChild(panel);
    widget.appendChild(btn);
    widget.appendChild(menu);
    return widget;
}

/**
 * Mount the switcher widget into a container.
 * @param {Element|string} target container element or css selector
 * @param {object} opts { prepend: bool, showName: bool }
 * @returns the widget element or null if target not found
 */
export function mountAppSwitch(target, opts = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) {
        return null;
    }
    // idempotent: never mount twice into the same container
    const existing = el.querySelector(':scope > .appswitch');
    if (existing) {
        return existing;
    }
    injectStyle();
    const widget = buildWidget(opts);
    if (opts.prepend) {
        el.insertBefore(widget, el.firstChild);
    } else {
        el.appendChild(widget);
    }
    return widget;
}

export default {
    APPS,
    currentApp,
    mountAppSwitch
};
