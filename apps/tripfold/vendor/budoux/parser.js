"use strict";
/**
 * @license
 * Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Parser = void 0;
/**
 * Base BudouX parser.
 */
class Parser {
    /**
     * Constructs a BudouX parser.
     * @param model A model data.
     */
    constructor(model) {
        this.model = new Map(Object.entries(model).map(([k, v]) => [
            k,
            new Map(Object.entries(v)),
        ]));
        this.baseScore =
            -0.5 *
                [...this.model.values()]
                    .flatMap((group) => [...group.values()])
                    .reduce((prev, curr) => prev + curr, 0);
    }
    /**
     * Parses the input sentence and returns a list of semantic chunks.
     *
     * @param sentence An input sentence.
     * @return The retrieved chunks.
     */
    parse(sentence) {
        if (sentence === '')
            return [];
        const boundaries = this.parseBoundaries(sentence);
        const result = [];
        let start = 0;
        for (const boundary of boundaries) {
            result.push(sentence.slice(start, boundary));
            start = boundary;
        }
        result.push(sentence.slice(start));
        return result;
    }
    /**
     * Parses the input sentence and returns a list of boundaries.
     *
     * @param sentence An input sentence.
     * @return The list of UTF-16 code unit offsets of the boundaries.
     */
    parseBoundaries(sentence) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const result = [];
        const uw1 = this.model.get('UW1');
        const uw2 = this.model.get('UW2');
        const uw3 = this.model.get('UW3');
        const uw4 = this.model.get('UW4');
        const uw5 = this.model.get('UW5');
        const uw6 = this.model.get('UW6');
        const bw1 = this.model.get('BW1');
        const bw2 = this.model.get('BW2');
        const bw3 = this.model.get('BW3');
        const tw1 = this.model.get('TW1');
        const tw2 = this.model.get('TW2');
        const tw3 = this.model.get('TW3');
        const tw4 = this.model.get('TW4');
        const chars = Array.from(sentence);
        let offset = 0;
        for (let i = 1; i < chars.length; i++) {
            offset += chars[i - 1].length;
            let score = this.baseScore;
            // NOTE: Score values in models may be negative.
            if (i > 2) {
                score += (_a = uw1 === null || uw1 === void 0 ? void 0 : uw1.get(chars[i - 3])) !== null && _a !== void 0 ? _a : 0;
                score += (_b = tw1 === null || tw1 === void 0 ? void 0 : tw1.get(chars[i - 3] + chars[i - 2] + chars[i - 1])) !== null && _b !== void 0 ? _b : 0;
            }
            if (i > 1) {
                score += (_c = uw2 === null || uw2 === void 0 ? void 0 : uw2.get(chars[i - 2])) !== null && _c !== void 0 ? _c : 0;
                score += (_d = bw1 === null || bw1 === void 0 ? void 0 : bw1.get(chars[i - 2] + chars[i - 1])) !== null && _d !== void 0 ? _d : 0;
                score += (_e = tw2 === null || tw2 === void 0 ? void 0 : tw2.get(chars[i - 2] + chars[i - 1] + chars[i])) !== null && _e !== void 0 ? _e : 0;
            }
            score += (_f = uw3 === null || uw3 === void 0 ? void 0 : uw3.get(chars[i - 1])) !== null && _f !== void 0 ? _f : 0;
            score += (_g = uw4 === null || uw4 === void 0 ? void 0 : uw4.get(chars[i])) !== null && _g !== void 0 ? _g : 0;
            score += (_h = bw2 === null || bw2 === void 0 ? void 0 : bw2.get(chars[i - 1] + chars[i])) !== null && _h !== void 0 ? _h : 0;
            if (i + 1 < chars.length) {
                score += (_j = uw5 === null || uw5 === void 0 ? void 0 : uw5.get(chars[i + 1])) !== null && _j !== void 0 ? _j : 0;
                score += (_k = bw3 === null || bw3 === void 0 ? void 0 : bw3.get(chars[i] + chars[i + 1])) !== null && _k !== void 0 ? _k : 0;
                score += (_l = tw3 === null || tw3 === void 0 ? void 0 : tw3.get(chars[i - 1] + chars[i] + chars[i + 1])) !== null && _l !== void 0 ? _l : 0;
            }
            if (i + 2 < chars.length) {
                score += (_m = uw6 === null || uw6 === void 0 ? void 0 : uw6.get(chars[i + 2])) !== null && _m !== void 0 ? _m : 0;
                score += (_o = tw4 === null || tw4 === void 0 ? void 0 : tw4.get(chars[i] + chars[i + 1] + chars[i + 2])) !== null && _o !== void 0 ? _o : 0;
            }
            if (score > 0)
                result.push(offset);
        }
        return result;
    }
}
exports.Parser = Parser;
//# sourceMappingURL=parser.js.map