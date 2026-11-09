/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

// UI FRONT END ANIMATION CODE for 2D

import { api } from '../../../app/api.js';
import { space } from '../../../../moto/space.js';

const { client } = api;

const asLines = false;
const asPoints = false;

let meshes = {},
    button = {},
    label = {},
    unitScale = 1,
    playing = false,
    speedValues = [ 1, 2, 4, 8, 32 ],
    speedPauses = [ 30, 20, 10, 5, 0 ],
    speedMax = speedValues.length - 1,
    speedIndex = 0,
    speed,
    color = 0,
    material,
    origin,
    posOffset = { x:0, y:0, z:0 };

export function animate_clear(api) {
    let { anim } = api.ui;
    playing = false;
    space.platform.showGridBelow(true);
    client.animate_cleanup();
    Object.keys(meshes).forEach(id => deleteMesh(id));
    toggleStock(undefined,true,false);
    api.uc.setVisible(anim.laba, false);
    api.uc.setVisible(anim.vala, false);
    // restore widget visibility hidden during animation (toggleModel)
    api.widgets.all().forEach(w => w.toggleVisibility(true));
    space.update();
}

export function animate(api) {
    api.show.busy("building animation");
    let settings = api.conf.get();
    client.animate_setup(settings, data => {
        checkMeshCommands(data);
        if (!(data && data.mesh_add)) {
            return;
        }

        let { anim } = api.ui;
        Object.assign(button, {
            replay: anim.replay,
            play: anim.play,
            step: anim.step,
            pause: anim.pause,
            trans: anim.trans,
            model: anim.model,
            shade: anim.shade
        });
        Object.assign(label, {
            progress: anim.progress,
            feed: anim.valf,
            x: anim.valx,
            y: anim.valy,
            z: anim.valz,
        });

        origin = settings.origin;
        speedIndex = api.local.getInt('cam.anim.speed') || 0;
        updateSpeed();
        anim.radios.forEach((radio, index) => {
            radio.onchange = () => setSpeed(index);
        });

        // no auto first step: the worker places the tool mesh explicitly at
        // its start position during setup, so playback waits for play/step

        button.replay.onclick = replay;
        button.play.onclick = play;
        button.step.onclick = step;
        button.pause.onclick = pause;
        button.trans.onclick = toggleTrans;
        button.model.onclick = toggleModel;
        button.shade.onclick = toggleStock;
        button.play.style.display = '';
        button.pause.style.display = 'none';

        api.event.emit('animate', 'CAM');
        api.show.busy(false);
        space.platform.showGridBelow(false);
        toggleTrans(0,api.local.getBoolean('cam.anim.trans', true));
        toggleModel(0,api.local.getBoolean('cam.anim.model', false));
        toggleStock(0,api.local.getBoolean('cam.anim.stock', false));
    });
}

Object.assign(client, {
    animate(data, ondone) {
        client.send("animate", data, ondone);
    },

    animate_setup(settings, ondone) {
        color = settings.controller.dark ? 0x48607B : 0x607FA4;
        unitScale = settings.controller.units === 'in' ? 1/25.4 : 1;
        let flatShading = true,
            transparent = true,
            opacity = 0.9,
            side = THREE.DoubleSide;
        material = new THREE.MeshPhongMaterial({
            flatShading,
            transparent,
            opacity,
            color,
            side
        });
        add_red_neg_z(material);
        client.send("animate_setup", {settings}, ondone);
    },

    animate_cleanup(data, ondone) {
        client.send("animate_cleanup", data, ondone);
    }
});

function meshAdd(id, ind, pos, sab) {
    const geo = new THREE.BufferGeometry();
    if (sab) {
        // use array buffer shared with worker
        pos = new Float32Array(sab);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (ind.length) {
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ind), 1));
    }
    let mesh;
    if (asPoints) {
        const mat = new THREE.PointsMaterial({
            transparent: true,
            opacity: 0.75,
            color: 0x888888,
            size: 0.3
        });
        mesh = new THREE.Points(geo, mat);
    } else if (asLines) {
        const mat = new THREE.LineBasicMaterial({
            transparent: true,
            opacity: 0.75,
            color
        });
        mesh = new THREE.LineSegments(geo, mat);
    } else {
        geo.computeVertexNormals();
        mesh = new THREE.Mesh(geo, material);
        mesh.renderOrder = -10;
    }
    space.world.add(mesh);
    meshes[id] = mesh;
}

function meshUpdates(id) {
    const mesh = meshes[id];
    if (!mesh) {
        return; // animate cancelled
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    space.update();
}

function deleteMesh(id) {
    space.world.remove(meshes[id]);
    delete meshes[id];
}

function toggleModel(ev,bool) {
    api.local.toggle('cam.anim.model', bool);
    api.widgets.all().forEach(w => w.toggleVisibility(bool));
}

function toggleStock(ev,bool,set) {
    set !== false && api.local.toggle('cam.anim.stock', bool);
    return api.event.emit('cam.stock.toggle', bool ?? undefined);
}

function toggleTrans(ev,bool) {
    bool = api.local.toggle('cam.anim.trans', bool);
    material.transparent = bool;
    material.needsUpdate = true;
}

function step() {
    playing = false;
    updateSpeed();
    client.animate({speed, steps: 1}, handleGridUpdate);
}

function play(opts = {}) {
    const { steps } = opts;
    updateSpeed();
    if (steps !== 1) {
        playing = true;
        button.play.style.display = 'none';
        button.pause.style.display = '';
    }
    // safe to re-issue while animating: worker updates renderSpeed
    // even when it skips starting a new render
    client.animate({
        speed,
        steps: steps || Infinity,
        pause: speedPauses[speedIndex]
    }, handleGridUpdate);
}

function pause() {
    playing = false;
    button.play.style.display = '';
    button.pause.style.display = 'none';
    client.animate({speed: 0}, handleGridUpdate);
}

function handleGridUpdate(data) {
    checkMeshCommands(data);
    if (data && data.progress) {
        label.progress.value = (data.progress * 100).toFixed(1);
    }
}

// sync internal speed state with selected radio (no playback change)
function updateSpeed() {
    speedIndex = Math.max(0, Math.min(speedIndex, speedMax));
    api.local.set('cam.anim.speed', speedIndex);
    speed = speedValues[speedIndex];
    api.ui.anim.radios.forEach((radio, index) => {
        radio.checked = index === speedIndex;
    });
}

// radio selection: set speed directly and re-issue animate when playing
function setSpeed(index) {
    speedIndex = index;
    updateSpeed();
    if (playing) {
        play();
    }
}

function replay() {
    animate_clear(api);
    setTimeout(() => {
        animate(api);
    }, 250);
}

function checkMeshCommands(data) {
    if (!data) {
        return;
    }
    if (data.mesh_add) {
        const { id, ind, pos, offset, sab } = data.mesh_add;
        meshAdd(id, ind, pos, sab);
        space.refresh();
        if (offset) {
            posOffset = offset;
        }
    }
    if (data.mesh_del) {
        deleteMesh(data.mesh_del);
    }
    if (data.mesh_move) {
        const { id, pos, speed } = data.mesh_move;
        const mesh = meshes[id];
        if (mesh) {
            mesh.position.x = pos.x;
            mesh.position.y = pos.y;
            mesh.position.z = pos.z;
            space.update();
        }
        label.x.value = (pos.x - origin.x).toFixed(2);
        label.y.value = (pos.y + origin.y).toFixed(2);
        label.z.value = (pos.z - origin.z).toFixed(2);
        label.feed.value = speed ? Math.round(speed) : 'G0';
    }
    if (data.mesh_update) {
        meshUpdates(data.id);
    }
}

// SHADER: tint points below z=0 with red
function add_red_neg_z(material) {
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
            `#include <worldpos_vertex>`,
            `
            #include <worldpos_vertex>
            vWorldPosition = vec3(transformed);
            `
        );

        shader.vertexShader = `
            varying vec3 vWorldPosition;
        ` + shader.vertexShader;

        shader.fragmentShader = `
            varying vec3 vWorldPosition;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            `#include <dithering_fragment>`,
            `
            #include <dithering_fragment>
            if (vWorldPosition.z < 0.0) {
                gl_FragColor.rgb += vec3(0.5, 0.0, 0.0); // Add red tint
            }
            `
        );
    };
    return material;
}
