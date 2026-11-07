/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { OpArea } from './op-area.js';
import { recordAreaSweep } from './stock.js';

class OpPocket extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    async slice(progress) {
        let { op, state } = this;
        let { contour, direction, down, expand, follow, outline, ov_botz, ov_topz } = op;
        let { plunge, rate, refine, smooth, spindle, surfaces, tolerance, tool } = op;
        let pocket = {
            areas: {},
            direction,
            down,
            expand,
            follow,
            mode: contour ? 'surface' : 'clear',
            outline,
            ov_botz,
            ov_topz,
            over: op.step,
            plunge,
            rate,
            refine,
            rename: op.rename ?? "pocket",
            smooth,
            spindle,
            sr_type: 'offset',
            spiral: op.spiral,
            spiral_finish: op.spiral_finish,
            surfaces,
            tolerance,
            tool,
            tr_type: 'none',
        };
        this.op_pocket = new OpArea(state, pocket);
        await this.op_pocket.slice(progress);
        // record this pass' material removal into the stock model. both
        // modes (clear raster and surface contouring) emit camLines with
        // cut z baked in. the recorded sweep is the ACTUAL sweep: clear
        // mode insets its centerlines by tool radius (+ leave_xy when
        // set), so the profile convolution never cuts past the pocket
        // wall or into any leave shell — the model reflects what the
        // tool really swept, not the theoretical full pocket removal
        recordAreaSweep(state, 'pocket', pocket, this.op_pocket);
    }

    prepare(ops, progress) {
        return this.op_pocket.prepare(ops, progress);
    }
}

export { OpPocket };
