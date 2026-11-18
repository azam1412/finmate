// Pengujian Stage 2.3c (level HTTP): GET /api/transactions dan GET /api/transactions/:id
// Jalankan dengan: npm test
// Server sungguhan (src/app.js) dijalankan di port 3231-3233. Data sementara (nama diawali
// "__test_") dihapus di akhir.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import { startServer, call } from "./helpers/httpServer.js";

const ALLOWED = "http://localhost:5173";
const FOREIGN = "http://evil.example";

let userA;
let userB;
let userEmpty;
let serverA;
let serverB;
let serverEmpty;
let wA1;
let wA2;
let wB1;
let incomeCat;
let expenseCat;
const t = {}; // id (string) transaksi seed user A
const bIds = [];

const D = (s) => new Date(s);

async function seed(user, wallet, props) {
    const row = await prisma.transaction.create({
        data: { userId: user.id, walletId: wallet.id, amount: "100.00", transactionDate: D("2026-01-01T00:00:00Z"), ...props },
    });
    return String(row.id);
}

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_hq_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_hq_b__" } });
    userEmpty = await prisma.user.create({ data: { name: "__test_hq_empty__" } });
    const wallet = (user) => prisma.wallet.create({ data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 1000 } });
    wA1 = await wallet(userA);
    wA2 = await wallet(userA);
    wB1 = await wallet(userB);
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_hq_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_hq_expense__", type: "EXPENSE" } });

    t.t1 = await seed(userA, wA1, { type: "INCOME", status: "CONFIRMED", source: "WEB", categoryId: incomeCat.id, description: "Gaji", transactionDate: D("2026-01-10T00:00:00Z") });
    t.t2 = await seed(userA, wA1, { type: "EXPENSE", status: "CONFIRMED", source: "TELEGRAM", categoryId: expenseCat.id, transactionDate: D("2026-02-10T00:00:00Z") });
    t.t3 = await seed(userA, wA2, { type: "EXPENSE", status: "PENDING", source: "WEB", categoryId: expenseCat.id, transactionDate: D("2026-03-10T00:00:00Z") });
    t.t4 = await seed(userA, wA1, { type: "TRANSFER", status: "CONFIRMED", source: "TELEGRAM", destinationWalletId: wA2.id, transactionDate: D("2026-04-10T00:00:00Z") });
    t.t5 = await seed(userA, wA2, { type: "TRANSFER", status: "PENDING", source: "WHATSAPP", destinationWalletId: wA1.id, transactionDate: D("2026-05-10T00:00:00Z") });
    t.t6 = await seed(userA, wA2, { type: "INCOME", status: "CANCELLED", source: "WHATSAPP", categoryId: incomeCat.id, transactionDate: D("2026-06-10T00:00:00Z") });

    bIds.push(await seed(userB, wB1, { type: "INCOME", status: "CONFIRMED", source: "WEB", categoryId: incomeCat.id, transactionDate: D("2026-01-10T00:00:00Z") }));
    bIds.push(await seed(userB, wB1, { type: "EXPENSE", status: "PENDING", source: "WEB", categoryId: expenseCat.id, transactionDate: D("2026-08-10T00:00:00Z") }));

    serverA = await startServer(3231, { DEFAULT_USER_ID: String(userA.id), CORS_ORIGINS: ALLOWED });
    serverB = await startServer(3232, { DEFAULT_USER_ID: String(userB.id), CORS_ORIGINS: ALLOWED });
    serverEmpty = await startServer(3233, { DEFAULT_USER_ID: String(userEmpty.id) });
});

after(async () => {
    serverA?.stop();
    serverB?.stop();
    serverEmpty?.stop();
    const userIds = [userA.id, userB.id, userEmpty.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const get = (server, path, options) => call(server.base, "GET", `/api/transactions${path}`, options);
const idsOf = (res) => res.json.data.map((x) => x.id);

function assertError(res, status, code) {
    assert.equal(res.status, status, `status ${res.status}: ${res.text}`);
    assert.equal(res.json?.success, false);
    assert.equal(res.json?.code, code);
}

// Tidak boleh ada KEY "userId" di respons mana pun.
const assertNoUserIdKey = (res) => assert.ok(!/"userId"\s*:/.test(res.text), `respons memuat key userId: ${res.text}`);

// ---------- daftar ----------

describe("GET /api/transactions", () => {
    test("200: bentuk { success, data: [...], pagination }, id dan amount berupa string, tanpa userId", async () => {
        const res = await get(serverA, "");
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.success, true);
        assert.deepEqual(Object.keys(res.json).sort(), ["data", "pagination", "success"]);
        assert.ok(Array.isArray(res.json.data));
        assert.deepEqual(idsOf(res), [t.t6, t.t5, t.t4, t.t3, t.t2, t.t1]);
        assert.deepEqual(res.json.pagination, { page: 1, limit: 20, total: 6, totalPages: 1 });

        for (const row of res.json.data) {
            assert.equal(typeof row.id, "string");
            assert.equal(typeof row.walletId, "string");
            assert.equal(typeof row.amount, "string");
            assert.match(row.amount, /^\d+\.\d{2}$/);
            assert.ok(["PENDING", "CONFIRMED", "CANCELLED"].includes(row.status));
        }
        assertNoUserIdKey(res);
    });

    test("200: user tanpa transaksi mendapat daftar kosong", async () => {
        const res = await get(serverEmpty, "");
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.json.data, []);
        assert.deepEqual(res.json.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    test("filter lewat HTTP: type, status, source, categoryId", async () => {
        assert.deepEqual(idsOf(await get(serverA, "?type=INCOME")), [t.t6, t.t1]);
        assert.deepEqual(idsOf(await get(serverA, "?status=PENDING")), [t.t5, t.t3]);
        assert.deepEqual(idsOf(await get(serverA, "?source=TELEGRAM")), [t.t4, t.t2]);
        assert.deepEqual(idsOf(await get(serverA, `?categoryId=${expenseCat.id}`)), [t.t3, t.t2]);
    });

    test("walletId: transfer ditemukan sebagai sumber maupun tujuan", async () => {
        assert.deepEqual(idsOf(await get(serverA, `?walletId=${wA1.id}&type=TRANSFER`)), [t.t5, t.t4]);
        assert.deepEqual(idsOf(await get(serverA, `?walletId=${wA2.id}&type=TRANSFER`)), [t.t5, t.t4]);
    });

    test("kombinasi filter dan rentang tanggal (dengan %2B07:00 dan Z)", async () => {
        const res = await get(serverA, `?from=2026-03-10T07:00:00%2B07:00&to=2026-05-10T00:00:00Z&status=PENDING`);
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(idsOf(res), [t.t5, t.t3]);
    });

    test("'+' pada zona waktu yang tidak di-encode dibaca sebagai spasi: 400 dengan petunjuk", async () => {
        const res = await get(serverA, `?from=2026-03-10T07:00:00+07:00`);
        assertError(res, 400, "VALIDATION_ERROR");
        assert.match(res.json.message, /%2B/);
    });

    test("pagination lewat HTTP", async () => {
        const p1 = await get(serverA, "?limit=4&page=1");
        const p2 = await get(serverA, "?limit=4&page=2");
        const p3 = await get(serverA, "?limit=4&page=3");
        assert.deepEqual(idsOf(p1), [t.t6, t.t5, t.t4, t.t3]);
        assert.deepEqual(idsOf(p2), [t.t2, t.t1]);
        assert.deepEqual(p3.json.data, []);
        assert.equal(p3.status, 200);
        assert.deepEqual(p3.json.pagination, { page: 3, limit: 4, total: 6, totalPages: 2 });
    });

    test("batas pagination: limit=100 dan page=10000 diterima, di atasnya 400", async () => {
        assert.equal((await get(serverA, "?limit=100&page=10000")).status, 200);
        assertError(await get(serverA, "?limit=101"), 400, "VALIDATION_ERROR");
        assertError(await get(serverA, "?page=10001"), 400, "VALIDATION_ERROR");
    });

    test("walletId/categoryId yang tidak ada atau milik user lain: 200 daftar kosong", async () => {
        for (const q of [`?walletId=${wB1.id}`, "?walletId=999999999999", "?categoryId=999999999999"]) {
            const res = await get(serverA, q);
            assert.equal(res.status, 200, q);
            assert.deepEqual(res.json.data, [], q);
            assert.equal(res.json.pagination.total, 0, q);
        }
    });
});

describe("GET /api/transactions: query tidak valid", () => {
    test("semua ini ditolak 400 VALIDATION_ERROR", async () => {
        const bad = [
            `?userId=${userB.id}`,
            "?foo=bar",
            "?sort=asc",
            "?type=income",
            "?type=INCOME&type=EXPENSE",
            "?type[]=INCOME",
            "?type[a]=1",
            "?type=",
            "?type",
            "?status=DONE",
            "?source=SMS",
            "?walletId=abc",
            "?walletId=1.5",
            "?walletId=0",
            "?categoryId=-1",
            "?from=2026-05-10",
            "?to=kemarin",
            "?from=2026-06-01T00:00:00Z&to=2026-05-01T00:00:00Z",
            "?page=0",
            "?page=1&page=2",
            "?page=1.5",
            "?limit=abc",
            "?limit=10abc",
            "?limit=1e2",
            "?walletId=1%20OR%201=1",
            "?type=INCOME'%20OR%20'1'='1",
        ];

        for (const query of bad) {
            const res = await get(serverA, query);
            assertError(res, 400, "VALIDATION_ERROR");
            assertNoUserIdKey(res);
        }
    });

    test("header X-User-Id diabaikan: daftar tetap milik user dari server", async () => {
        const res = await get(serverA, "", { headers: { "X-User-Id": String(userB.id) } });
        assert.equal(res.status, 200);
        assert.deepEqual(idsOf(res), [t.t6, t.t5, t.t4, t.t3, t.t2, t.t1]);
    });
});

// ---------- detail ----------

describe("GET /api/transactions/:id", () => {
    test("200: { success, data: transaksi } dengan bentuk SAMA PERSIS dengan respons create", async () => {
        const created = await call(serverA.base, "POST", "/api/transactions/income", {
            body: { walletId: String(wA1.id), categoryId: String(incomeCat.id), amount: "75.50", source: "WEB", description: "Uji bentuk" },
        });
        assert.equal(created.status, 201, created.text);

        const res = await get(serverA, `/${created.json.data.id}`);
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(Object.keys(res.json).sort(), ["data", "success"]);
        assert.deepEqual(res.json.data, created.json.data);
        assertNoUserIdKey(res);
    });

    test("detail transaksi seed: field dan tipe benar (transfer punya dompet tujuan, tanpa kategori)", async () => {
        const res = await get(serverA, `/${t.t4}`);
        assert.equal(res.status, 200, res.text);
        const row = res.json.data;
        assert.equal(row.id, t.t4);
        assert.equal(row.type, "TRANSFER");
        assert.equal(row.walletId, String(wA1.id));
        assert.equal(row.destinationWalletId, String(wA2.id));
        assert.equal(row.categoryId, null);
        assert.equal(row.amount, "100.00");
    });

    test("404 TRANSACTION_NOT_FOUND untuk id yang tidak ada", async () => {
        assertError(await get(serverA, "/999999999999"), 404, "TRANSACTION_NOT_FOUND");
    });

    test("400 VALIDATION_ERROR untuk id tidak valid, termasuk /income yang tertangkap sebagai id", async () => {
        for (const id of ["abc", "0", "-1", "1.5", "1e3", "%20", "99999999999999999999", "9223372036854775808", "income"]) {
            assertError(await get(serverA, `/${id}`), 400, "VALIDATION_ERROR");
        }
    });

    test("query string apa pun pada detail ditolak 400", async () => {
        assertError(await get(serverA, `/${t.t1}?userId=${userB.id}`), 400, "VALIDATION_ERROR");
        assertError(await get(serverA, `/${t.t1}?_=123`), 400, "VALIDATION_ERROR");
    });
});

// ---------- isolasi antar pengguna ----------

describe("isolasi data antar pengguna (daftar dan detail)", () => {
    test("daftar tiap user hanya berisi transaksi miliknya", async () => {
        const a = await get(serverA, "");
        const b = await get(serverB, "");
        assert.deepEqual(idsOf(b).sort(), [...bIds].sort());
        for (const id of bIds) assert.ok(!idsOf(a).includes(id));
        for (const key of Object.keys(t)) assert.ok(!idsOf(b).includes(t[key]));
    });

    test("detail: transaksi user lain dan id yang tidak ada memberi 404 yang identik", async () => {
        const foreign = await get(serverA, `/${bIds[0]}`);
        const missing = await get(serverA, "/999999999999");
        assertError(foreign, 404, "TRANSACTION_NOT_FOUND");
        assert.deepEqual(foreign.json, missing.json);
        assertError(await get(serverB, `/${t.t1}`), 404, "TRANSACTION_NOT_FOUND");
    });

    test("filter walletId/categoryId/type tidak bisa dipakai membuka data user lain", async () => {
        assert.deepEqual((await get(serverB, `?walletId=${wA1.id}`)).json.data, []);
        assert.deepEqual((await get(serverA, `?walletId=${wB1.id}`)).json.data, []);
        // total dibandingkan dengan hitungan langsung di database per user (tes lain di file ini
        // ikut membuat transaksi INCOME untuk user A, jadi angkanya tidak dikunci ke 2)
        const countFor = (user) => prisma.transaction.count({ where: { userId: user.id, type: "INCOME" } });
        assert.equal((await get(serverA, "?type=INCOME")).json.pagination.total, await countFor(userA));
        assert.equal((await get(serverB, "?type=INCOME")).json.pagination.total, await countFor(userB));
        assert.equal(await countFor(userB), 1);
    });

    test("userId di query tidak mengubah pemilik: daftar dan detail menolak 400", async () => {
        assertError(await get(serverA, `?userId=${userB.id}`), 400, "VALIDATION_ERROR");
        assertError(await get(serverA, `/${bIds[0]}?userId=${userB.id}`), 400, "VALIDATION_ERROR");
    });
});

// ---------- idempotencyKey tanpa awalan userId pada SEMUA respons ----------

describe("idempotencyKey tidak membocorkan awalan userId", () => {
    test("create, replay, confirm, cancel, detail, dan daftar mengembalikan kunci tanpa awalan", async () => {
        const key = `kunci-http-${Date.now()}`;
        const prefixed = `${userA.id}:${key}`;
        const body = { walletId: String(wA1.id), categoryId: String(incomeCat.id), amount: "10.00", source: "WEB", idempotencyKey: key };

        const created = await call(serverA.base, "POST", "/api/transactions/income", { body });
        assert.equal(created.status, 201, created.text);
        const id = created.json.data.id;

        // prasyarat: di database kunci tersimpan dengan awalan, sehingga tes ini tidak kosong
        const stored = await prisma.transaction.findUnique({ where: { id: BigInt(id) } });
        assert.equal(stored.idempotencyKey, prefixed);

        const replay = await call(serverA.base, "POST", "/api/transactions/income", { body });
        const detail = await get(serverA, `/${id}`);
        const list = await get(serverA, "?limit=100");
        const confirmed = await call(serverA.base, "POST", `/api/transactions/${id}/confirm`, { body: {} });
        const detailConfirmed = await get(serverA, `/${id}`);
        const cancelled = await call(serverA.base, "POST", `/api/transactions/${id}/cancel`, { body: {} });
        const listAfter = await get(serverA, "?status=CANCELLED");

        for (const [name, res] of Object.entries({ created, replay, detail, list, confirmed, detailConfirmed, cancelled, listAfter })) {
            assert.ok(res.status === 200 || res.status === 201, `${name}: ${res.status} ${res.text}`);
            assert.ok(!res.text.includes(prefixed), `${name} membocorkan kunci berawalan userId`);
        }

        assert.equal(created.json.data.idempotencyKey, key);
        assert.equal(replay.json.data.idempotencyKey, key);
        assert.equal(detail.json.data.idempotencyKey, key);
        assert.equal(confirmed.json.data.transaction.idempotencyKey, key);
        assert.equal(cancelled.json.data.transaction.idempotencyKey, key);
        assert.equal(list.json.data.find((x) => x.id === id).idempotencyKey, key);
        assert.equal(listAfter.json.data.find((x) => x.id === id).idempotencyKey, key);
    });

    test("user lain tidak melihat transaksi bertanda kunci user pertama", async () => {
        const res = await get(serverB, "?limit=100");
        assert.ok(!res.text.includes(`${userA.id}:kunci-http`));
        assert.ok(res.json.data.every((x) => !String(x.idempotencyKey ?? "").startsWith("kunci-http")));
    });
});

// ---------- keamanan dan perilaku umum ----------

describe("keamanan dan perilaku umum", () => {
    test("GET tidak memerlukan Content-Type JSON (JSON guard hanya untuk method yang mengubah data)", async () => {
        assert.equal((await get(serverA, "")).status, 200);
        assert.equal((await get(serverA, `/${t.t1}`)).status, 200);
    });

    test("CORS: origin yang diizinkan mendapat header, origin asing tidak", async () => {
        const allowed = await get(serverA, "", { headers: { Origin: ALLOWED } });
        const foreign = await get(serverA, "", { headers: { Origin: FOREIGN } });
        assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED);
        assert.equal(foreign.headers.get("access-control-allow-origin"), null);
        assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");
    });

    test("membaca tidak mengubah data: jumlah baris, status, dan saldo tetap", async () => {
        const rows = () => prisma.transaction.findMany({ where: { userId: userA.id }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } });
        const before = await rows();
        await Promise.all([get(serverA, ""), get(serverA, `/${t.t1}`), get(serverA, "?status=PENDING")]);
        assert.deepEqual(await rows(), before);
    });

    test("pembacaan bersamaan dengan konfirmasi tidak saling menghalangi atau gagal", async () => {
        const created = await Promise.all(
            Array.from({ length: 4 }, () =>
                call(serverA.base, "POST", "/api/transactions/income", {
                    body: { walletId: String(wA2.id), categoryId: String(incomeCat.id), amount: "5.00", source: "WEB" },
                })
            )
        );
        const ids = created.map((c) => c.json.data.id);

        const results = await Promise.all([
            ...ids.map((id) => call(serverA.base, "POST", `/api/transactions/${id}/confirm`, { body: {} })),
            ...Array.from({ length: 12 }, (_, i) => (i % 2 ? get(serverA, "?limit=100") : get(serverA, `/${ids[i % 4]}`))),
        ]);

        for (const r of results) assert.equal(r.status, 200, r.text);
    });

    test("POST /api/transactions (tanpa path) dan metode lain pada rute baca tetap 404", async () => {
        assertError(await call(serverA.base, "POST", "/api/transactions", { body: {} }), 404, "ROUTE_NOT_FOUND");
        assertError(await call(serverA.base, "GET", `/api/transactions/${t.t1}/extra`), 404, "ROUTE_NOT_FOUND");
    });

    test("endpoint lama tetap berfungsi: /, /health, /api/me", async () => {
        assert.equal((await call(serverA.base, "GET", "/")).status, 200);
        assert.equal((await call(serverA.base, "GET", "/health")).status, 200);
        const me = await call(serverA.base, "GET", "/api/me");
        assert.equal(me.json.data.id, String(userA.id));
    });
});
