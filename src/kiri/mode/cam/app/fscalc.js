/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/**
 * Advisory feed/speed calculator for CAM (phase 1 of the cutting
 * velocity/depth estimator). Pure functions -- no UI, no settings
 * mutation. Results are RECOMMENDATIONS only: nothing here is ever
 * silently applied to process settings by the caller.
 *
 * Core formula:  Vf = spindle_rpm × flutes × fz
 *
 * fz is estimated from the tool diameter with a linear model
 * (fz ≈ k × D) calibrated from the analysis in `estimate-velocity.mc`
 * (repo root). The model is valid for D ≈ 3..16-20mm. Below ~3mm the
 * linear model breaks down (tool strength, not chip volume, becomes
 * the limit) and fz is clamped to a narrow 0.01-0.02 mm/tooth band.
 *
 * The material table is a starting point pending verification
 * (research task 97a294a7); its findings should be merged into
 * MATERIALS below in a separate change.
 */

 // per-material cutting coefficients. k is mm/tooth per mm of tool
 // diameter (fz ≈ k × D). docPct is max depth of cut as a fraction of
 // tool diameter [conservative, aggressive]. All values in mm.
const MATERIALS = {
    aluminum: {
        label: "aluminum",
        kLo: 0.008,
        kHi: 0.012,
        docPct: [0.25, 0.5],
        warnings: [
            "aluminum: chip evacuation is critical -- clear chips frequently and use air/mist cooling"
        ]
    },
    hardwood: {
        label: "hardwood (oak, beech)",
        kLo: 0.009,
        kHi: 0.011,
        docPct: [0.5, 1.0],
        warnings: []
    },
    softwood: {
        label: "softwood (pine)",
        kLo: 0.010,
        kHi: 0.012,
        docPct: [0.5, 1.0],
        warnings: []
    },
    mdf: {
        label: "MDF / plywood",
        kLo: 0.012,
        kHi: 0.014,
        docPct: [0.5, 1.0],
        warnings: [
            "MDF: abrasive dust -- use dust extraction and expect shorter tool life"
        ]
    },
    plastic: {
        label: "plastic (POM, PA)",
        kLo: 0.010,
        kHi: 0.015,
        docPct: [0.5, 1.0],
        warnings: [
            "plastic: watch for chip re-welding -- keep feed high enough to clear chips"
        ]
    },
    acrylic: {
        label: "acrylic (PMMA)",
        kLo: 0.010,
        kHi: 0.015,
        // acrylic also has an explicit fz band from reference tables
        fzAbsLo: 0.03,
        fzAbsHi: 0.06,
        docPct: [0.5, 1.0],
        warnings: [
            "acrylic: prone to melting/chipping -- single flute and sharp tools help"
        ]
    }
};

// small diameter tools: linear fz ≈ k×D model breaks down below ~3mm
// (fragility of the tool becomes the limit, see estimate-velocity.mc)
const SMALL_DIAM_MM = 3;
const SMALL_FZ_MM = [0.01, 0.02];

// plunge rate as a fraction of feed rate [conservative, aggressive]
const PLUNGE_PCT = [1 / 3, 1 / 2];

const MM_PER_INCH = 25.4;

function clamp(val, lo, hi) {
    return Math.min(Math.max(val, lo), hi);
}

/**
 * resolve the material record for a material key or display label
 *
 * @param {string} material key or label from MATERIALS
 * @returns {object|undefined} material record
 */
function lookupMaterial(material) {
    if (!material) return undefined;
    const key = String(material).toLowerCase().trim();
    if (MATERIALS[key]) return MATERIALS[key];
    return Object.values(MATERIALS)
        .find(m => m.label.toLowerCase() === key);
}

/**
 * resolve a tool record. accepts either a plain settings tool record
 * ({ flute_diam, metric, flutes, ... }) or a Tool instance from
 * mode/cam/core/tool.js
 *
 * @param {object|Tool} tool tool record or Tool instance
 * @returns {object} normalized { diamMm, flutes, metric }
 */
function toolSpec(tool) {
    const rec = tool?.tool ?? tool;
    const metric = rec?.metric !== false;
    const diam = (rec?.flute_diam ?? 0) * (metric ? 1 : MM_PER_INCH);
    return {
        diamMm: diam,
        flutes: Math.max(1, rec?.flutes ?? 2),
        metric
    };
}

/**
 * compute a recommended fz range in mm/tooth for a material + diameter
 *
 * @param {object} mat material record from MATERIALS
 * @param {number} diamMm tool diameter in mm
 * @returns {number[]} [fzLo, fzHi] in mm/tooth
 */
function fzRange(mat, diamMm) {
    // small tools: narrow fixed band, linear model does not apply
    if (diamMm < SMALL_DIAM_MM) {
        return SMALL_FZ_MM.slice();
    }
    let lo = mat.kLo * diamMm,
        hi = mat.kHi * diamMm;
    // materials with an absolute fz band (acrylic) are clamped to it
    if (mat.fzAbsLo !== undefined) {
        lo = clamp(lo, mat.fzAbsLo, mat.fzAbsHi);
        hi = clamp(hi, mat.fzAbsLo, mat.fzAbsHi);
    }
    return [lo, hi];
}

/**
 * recommend feed/speed parameters for a material/tool/spindle combo.
 * advisory only -- callers must present these to the user, never
 * apply them silently.
 *
 * @param {string} material material key or label (see MATERIALS)
 * @param {object|Tool} tool tool record or Tool instance
 * @param {number} spindle spindle speed in RPM
 * @param {object} [opts] options
 * @param {number} [opts.flutes] override tool flute count
 * @param {string} [opts.units] output units "mm" (default) or "inch"
 * @param {number} [opts.docPct] override max DOC fraction of diameter
 * @returns {object} {
 *   fzLo, fzHi         feed per tooth (mm or inch per tooth)
 *   vfLo, vfHi         feed rate Vf (mm/min or inch/min)
 *   plungeLo, plungeHi plunge rate (1/3 - 1/2 of Vf)
 *   maxDoc             max depth of cut (conservative, tool units)
 *   maxDocRange        [conservative, aggressive] max DOC
 *   warnings           advisory warnings list
 * }
 */
function recommend(material, tool, spindle, opts = {}) {
    const warnings = [];
    const mat = lookupMaterial(material);
    const spec = toolSpec(tool);

    if (!mat) {
        warnings.push(`unknown material "${material}"`);
        return { fzLo: 0, fzHi: 0, vfLo: 0, vfHi: 0, plungeLo: 0, plungeHi: 0, maxDoc: 0, maxDocRange: [0, 0], warnings };
    }
    if (!(spindle > 0)) {
        warnings.push("spindle speed must be > 0");
    }
    if (!(spec.diamMm > 0)) {
        warnings.push("tool flute diameter must be > 0");
    }

    const flutes = opts.flutes ?? spec.flutes;
    const outInch = (opts.units ?? (spec.metric ? "mm" : "inch")) === "inch";
    const unitScale = outInch ? 1 / MM_PER_INCH : 1;
    const rpm = Math.max(0, spindle);

    let [fzLo, fzHi] = fzRange(mat, spec.diamMm);

    if (spec.diamMm > 0 && spec.diamMm < SMALL_DIAM_MM) {
        warnings.push(`tool diameter ${spec.diamMm.toFixed(2)}mm is below 3mm: ` +
            `linear fz model does not apply, using fixed fz band ` +
            `${SMALL_FZ_MM[0]}-${SMALL_FZ_MM[1]} mm/tooth`);
    }
    if (spec.diamMm > 20) {
        warnings.push("tool diameter above ~20mm: feed may be limited by " +
            "machine power/rigidity rather than the tool");
    }
    // Vf = rpm × flutes × fz  (mm/min)
    const vfLo = rpm * flutes * fzLo;
    const vfHi = rpm * flutes * fzHi;

    // max depth of cut as a fraction of diameter
    const docPctLo = opts.docPct ?? mat.docPct[0];
    const docLo = docPctLo * spec.diamMm;
    const docHi = mat.docPct[1] * spec.diamMm;

    for (const w of mat.warnings) {
        warnings.push(w);
    }

    return {
        fzLo: fzLo * unitScale,
        fzHi: fzHi * unitScale,
        vfLo: vfLo * unitScale,
        vfHi: vfHi * unitScale,
        plungeLo: vfLo * PLUNGE_PCT[0] * unitScale,
        plungeHi: vfHi * PLUNGE_PCT[1] * unitScale,
        maxDoc: docLo * unitScale,
        maxDocRange: [docLo * unitScale, docHi * unitScale],
        warnings
    };
}

export {
    MATERIALS,
    MM_PER_INCH,
    lookupMaterial,
    recommend
};
