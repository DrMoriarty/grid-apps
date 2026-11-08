/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/**
 * Look-ahead print time planner (simplified GRBL/Marlin style).
 *
 * Firmware motion controllers do not run segments at constant feedrate:
 * they accelerate into a move, decelerate out of it, and slow down at
 * junctions between segments whose direction change exceeds what the
 * junction deviation / acceleration limits allow. A pure length/feedrate
 * estimate therefore under-reports time on paths made of short segments
 * (fine perimeters, dense infill).
 *
 * This module queues the motion produced during gcode export and, once
 * the chain is complete, runs classic planner passes over it:
 *
 * - junction velocity at each corner from a junction-deviation model:
 *       vj = sqrt( accel * junction * sin(theta/2) / (1 - sin(theta/2)) )
 *   (theta = interior corner angle), capped by the cruise speed of
 *   both neighboring segments;
 * - a backward pass limiting exit velocities so each segment can brake
 *   to its successor (full stop at chain end and at explicit barriers);
 * - a forward pass limiting entry velocities to what each segment can
 *   reach from its start;
 * - passes repeat until velocities converge;
 * - per-segment time integrates the trapezoid (or triangle when the
 *   segment is too short to reach cruise speed).
 *
 * It is a scalar (path-speed) model: per-axis acceleration limits and
 * rotary axis coupling are out of scope. Accuracy depends on the user
 * supplied acceleration and junction deviation values.
 */

const EPS = 1e-6;

/**
 * Time to traverse one segment given entry/exit velocities, cruise
 * (max) velocity and acceleration.
 * @param {number} d segment length (mm)
 * @param {number} ve entry velocity (mm/s)
 * @param {number} vx exit velocity (mm/s)
 * @param {number} vmax cruise / target velocity (mm/s)
 * @param {number} a acceleration (mm/s^2)
 * @returns {number} seconds
 */
function segmentTime(d, ve, vx, vmax, a) {
    if (!(d > EPS)) {
        return 0;
    }
    if (!(vmax > EPS)) {
        return 0;
    }
    if (!(a > EPS)) {
        return d / vmax;
    }
    ve = Math.min(Math.max(ve, 0), vmax);
    vx = Math.min(Math.max(vx, 0), vmax);
    // distance needed to reach cruise from ve and brake to vx
    const dacc = (vmax * vmax - ve * ve) / (2 * a),
        ddec = (vmax * vmax - vx * vx) / (2 * a);
    if (dacc + ddec <= d) {
        // trapezoidal profile
        return (vmax - ve) / a + (vmax - vx) / a + (d - dacc - ddec) / vmax;
    }
    // triangular profile: peak velocity below cruise
    let vp = Math.sqrt((2 * a * d + ve * ve + vx * vx) / 2);
    vp = Math.max(vp, ve, vx);
    return (vp - ve) / a + (vp - vx) / a;
}

/**
 * Junction velocity (exit speed of m1 / entry speed of m2) using the
 * GRBL junction-deviation model:
 *
 *   vj = sqrt( accel * junction * sin(theta/2) / (1 - sin(theta/2)) )
 *
 * where theta is the interior corner angle (pi = straight through).
 * vj diverges toward straight junctions (capped by cruise speeds) and
 * approaches zero for full reversals.
 * @returns {number} mm/s
 */
function junctionVelocity(m1, m2, junction) {
    if (m1.stop || m2.stop) {
        return 0;
    }
    const u = m1.dir,
        v = m2.dir;
    if (!u || !v) {
        return 0;
    }
    const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; // cos(deflection)
    let sh = Math.sqrt(Math.max(0, 0.5 * (1 + dot))); // sin(theta/2)
    if (sh >= 0.999999) {
        // straight continuation: limited only by cruise speeds
        return Math.min(m1.v, m2.v);
    }
    if (sh < 0.001) {
        sh = 0.001; // near full reversal: crawl through the corner
    }
    const a = Math.min(m1.a, m2.a),
        vj = Math.sqrt((a * junction * sh) / (1 - sh));
    return Math.min(vj, m1.v, m2.v);
}

export class AccelPlanner {
    /**
     * @param {object} opt {
     *   accel:     print move acceleration (mm/s^2, required > 0)
     *   travel:    travel move acceleration (mm/s^2, default = accel)
     *   junction:  junction deviation (mm, default 0.05)
     *   startV:    entry velocity of chain (mm/s, default 0)
     *   endV:      exit velocity of chain (mm/s, default 0)
     * }
     */
    constructor(opt = {}) {
        this.accel = opt.accel || 0;
        this.travelAccel = opt.travel || this.accel;
        this.junction = opt.junction > 0 ? opt.junction : 0.05;
        this.startV = opt.startV || 0;
        this.endV = opt.endV || 0;
        this.moves = [];
    }

    enabled() {
        return this.accel > 0;
    }

    /**
     * Queue a move for planning.
     * @param {number} dist segment length (mm)
     * @param {number} feed target speed (mm/s)
     * @param {boolean} travel true for non-print (seek) moves
     * @param {number} [dx] motion delta used for junction direction
     * @param {number} [dy]
     * @param {number} [dz]
     */
    queue(dist, feed, travel, dx = 0, dy = 0, dz = 0) {
        if (!(dist > EPS) || !(feed > EPS)) {
            return;
        }
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.moves.push({
            d: dist,
            v: feed,
            a: travel ? this.travelAccel : this.accel,
            dir: len > EPS ? [dx / len, dy / len, dz / len] : null,
            stop: false
        });
    }

    /**
     * Force a full stop junction at the end of the currently queued
     * chain (used for dwells, retracts, tool changes, rotary moves).
     */
    barrier() {
        if (this.moves.length) {
            this.moves[this.moves.length - 1].stop = true;
        }
    }

    /**
     * Run the look-ahead passes over queued moves and return total
     * motion time in seconds. Queue is reset.
     * @returns {number} seconds
     */
    finish() {
        const moves = this.moves,
            n = moves.length;
        this.moves = [];
        if (!n) {
            return 0;
        }
        const d = new Float64Array(n),
            vmax = new Float64Array(n),
            acc = new Float64Array(n),
            entry = new Float64Array(n),
            exit = new Float64Array(n);

        for (let i = 0; i < n; i++) {
            const m = moves[i];
            d[i] = m.d;
            vmax[i] = m.v;
            acc[i] = m.a > EPS ? m.a : 0;
        }

        // junction velocity entering move i (1..n-1)
        entry[0] = this.startV;
        for (let i = 1; i < n; i++) {
            entry[i] = junctionVelocity(moves[i - 1], moves[i], this.junction);
        }
        for (let i = 0; i < n - 1; i++) {
            exit[i] = moves[i].stop ? 0 : entry[i + 1];
        }
        exit[n - 1] = this.endV;

        // repeat backward/forward passes until velocities converge
        for (let iter = 0; iter < 8; iter++) {
            let delta = 0;
            // backward pass: cap exit[i] so move i+1 can brake, and
            // cap entry[i] so move i can reach exit[i]
            for (let i = n - 1; i >= 0; i--) {
                let x = Math.min(exit[i], vmax[i]);
                if (i < n - 1) {
                    x = Math.min(x, Math.sqrt(exit[i + 1] ** 2 + 2 * acc[i + 1] * d[i + 1]));
                }
                if (x < 0) x = 0;
                delta = Math.max(delta, Math.abs(x - exit[i]));
                exit[i] = x;
                let e = Math.min(entry[i], Math.sqrt(x * x + 2 * acc[i] * d[i]), vmax[i]);
                if (e < 0) e = 0;
                delta = Math.max(delta, Math.abs(e - entry[i]));
                entry[i] = e;
                if (i > 0 && exit[i - 1] > e) {
                    delta = Math.max(delta, exit[i - 1] - e);
                    exit[i - 1] = e;
                }
            }
            // forward pass: cap entry[i] to reachable from exit[i-1]
            // and exit[i] to reachable from entry[i]
            for (let i = 0; i < n; i++) {
                let e = i > 0 ? Math.min(entry[i], exit[i - 1]) : entry[i];
                delta = Math.max(delta, Math.abs(e - entry[i]));
                entry[i] = e;
                let x = Math.min(exit[i], Math.sqrt(e * e + 2 * acc[i] * d[i]));
                delta = Math.max(delta, Math.abs(x - exit[i]));
                exit[i] = x;
            }
            if (delta < 0.01) {
                break;
            }
        }

        // integrate per-segment trapezoidal profiles
        let total = 0;
        for (let i = 0; i < n; i++) {
            total += segmentTime(d[i], entry[i], exit[i], vmax[i], acc[i]);
        }

        return total;
    }
}
