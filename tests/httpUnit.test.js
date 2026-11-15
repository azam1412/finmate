// Pengujian unit Stage 2.3a (tanpa server dan tanpa database):
//  - pemetaan error di errorHandler (khususnya P2034 -> 503 TRANSACTION_CONFLICT, bukan semua error DB)
//  - parsing CORS_ORIGINS
// P2034 (deadlock/konflik tulis) tidak bisa dipancing dengan andal di database uji, jadi
// pemetaannya diuji dengan error buatan bertipe Prisma.PrismaClientKnownRequestError.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import { errorHandler } from "../src/middleware/errorHandler.js";
import { parseAllowedOrigins, buildCorsOptions } from "../src/config/cors.js";
import AppError from "../src/utils/AppError.js";

function run(err) {
    const res = {
        headers: {},
        headersSent: false,
        set(k, v) { this.headers[k] = v; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    errorHandler(err, {}, res, () => assert.fail("next() tidak boleh dipanggil"));
    return res;
}

const prismaError = (code) =>
    new Prisma.PrismaClientKnownRequestError("RAW DB MESSAGE secret-detail", { code, clientVersion: "test" });

describe("errorHandler: pemetaan error database", () => {
    let originalError;
    beforeEach(() => { originalError = console.error; console.error = () => {}; });
    afterEach(() => { console.error = originalError; });

    test("P2034 -> 503 TRANSACTION_CONFLICT dengan Retry-After", () => {
        const res = run(prismaError("P2034"));
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, "TRANSACTION_CONFLICT");
        assert.equal(res.headers["Retry-After"], "1");
        assert.ok(!JSON.stringify(res.body).includes("secret-detail"));
    });

    test("P2028 tetap -> 503 DATABASE_BUSY (bukan TRANSACTION_CONFLICT)", () => {
        const res = run(prismaError("P2028"));
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, "DATABASE_BUSY");
    });

    test("P2002 -> 409 dan P2025 -> 404", () => {
        assert.equal(run(prismaError("P2002")).statusCode, 409);
        assert.equal(run(prismaError("P2025")).statusCode, 404);
    });

    test("kode database lain (P2003, P2010, P1001, P2024) TIDAK dianggap busy/conflict: tetap 500", () => {
        for (const code of ["P2003", "P2010", "P1001", "P2024", "P2033"]) {
            const res = run(prismaError(code));
            assert.equal(res.statusCode, 500, code);
            assert.equal(res.body.code, "INTERNAL_ERROR", code);
            assert.equal(res.headers["Retry-After"], undefined, code);
            assert.ok(!JSON.stringify(res.body).includes("secret-detail"), code);
        }
    });

    test("objek biasa yang kebetulan punya code P2034 (bukan error Prisma) -> 500", () => {
        const fake = Object.assign(new Error("x"), { code: "P2034" });
        assert.equal(run(fake).statusCode, 500);
    });

    test("error tak dikenal -> 500 tanpa membocorkan pesan; AppError tetap dihormati", () => {
        const res = run(new Error("kata sandi db = abc"));
        assert.equal(res.statusCode, 500);
        assert.ok(!JSON.stringify(res.body).includes("kata sandi"));
        assert.equal(run(new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "m")).statusCode, 415);
    });
});

describe("CORS_ORIGINS", () => {
    const quiet = () => {};

    test("kosong/tidak ada -> tidak ada origin diizinkan", () => {
        assert.deepEqual(parseAllowedOrigins(undefined, quiet), []);
        assert.deepEqual(parseAllowedOrigins("", quiet), []);
        assert.deepEqual(parseAllowedOrigins("  ,  ", quiet), []);
    });

    test("daftar dipisah koma: di-trim, huruf kecil, slash akhir dibuang, duplikat digabung", () => {
        assert.deepEqual(
            parseAllowedOrigins(" http://localhost:5173/ , HTTP://LocalHost:5173, https://app.example.com ", quiet),
            ["http://localhost:5173", "https://app.example.com"]
        );
    });

    test("wildcard, path, skema selain http(s), dan sampah diabaikan dengan peringatan", () => {
        const warnings = [];
        const result = parseAllowedOrigins(
            "*, http://ok.test, http://x.test/path, ftp://x.test, bukan-url, http://u:p@x.test",
            (m) => warnings.push(m)
        );
        assert.deepEqual(result, ["http://ok.test"]);
        assert.equal(warnings.length, 5);
    });

    test("buildCorsOptions.origin: hanya origin terdaftar yang lolos", () => {
        const { origin } = buildCorsOptions({ CORS_ORIGINS: "http://a.test" }, quiet);
        const decide = (o) => { let r; origin(o, (e, v) => { r = v; }); return r; };
        assert.equal(decide("http://a.test"), true);
        assert.equal(decide("http://A.test"), true);
        assert.equal(decide("http://b.test"), false);
        assert.equal(decide("null"), false);
        assert.equal(decide(undefined), false);
    });
});
