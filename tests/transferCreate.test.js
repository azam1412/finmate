// Pengujian Stage 2.2c: pembuatan transaksi TRANSFER.
// Jalankan dengan: npm test
// Tes membuat user, dompet, dan kategori SEMENTARA (nama diawali "__test_") lalu menghapusnya kembali.
// Data seed milik Anda tidak disentuh dan tidak dipakai.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { jsonReplacer } from "../src/utils/serialize.js";
import { runInTransaction, lockWallets } from "../src/utils/dbTransaction.js";
import { getWalletBalances } from "../src/services/balanceService.js";
import { createIncome, createTransfer } from "../src/services/transactionService.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userA;
let userB;
let incomeCat; // kategori global INCOME (untuk tes lintas tipe)
let expenseCat; // kategori global EXPENSE

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_transfer_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_transfer_b__" } });
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_tr_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_tr_expense__", type: "EXPENSE" } });
});

after(async () => {
    const userIds = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const newWallet = (user, extra = {}) =>
    prisma.wallet.create({
        data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 1000, ...extra },
    });

// Dua dompet milik user A (saldo awal 1000 masing-masing)
const twoWallets = async (user = userA) => [await newWallet(user), await newWallet(user)];

const countTx = (...walletIds) =>
    prisma.transaction.count({
        where: { OR: [{ walletId: { in: walletIds } }, { destinationWalletId: { in: walletIds } }] },
    });

const transferInput = (from, to, overrides = {}) => ({
    walletId: String(from.id),
    destinationWalletId: String(to.id),
    amount: "25000.50",
    source: "WEB",
    ...overrides,
});

function rejectsWith(promise, statusCode, code) {
    return assert.rejects(promise, (err) => {
        assert.ok(err instanceof AppError, `bukan AppError: ${err?.stack ?? err}`);
        assert.equal(err.statusCode, statusCode, `status: ${err.statusCode} (${err.code})`);
        assert.equal(err.code, code);
        return true;
    });
}

// ---------- tes ----------

describe("pembuatan TRANSFER (jalur sukses)", () => {
    test("tersimpan PENDING bertipe TRANSFER dengan sumber, tujuan, dan nominal yang benar", async () => {
        const [from, to] = await twoWallets();
        const before = Date.now();
        const { transaction, created } = await createTransfer(
            userA.id,
            transferInput(from, to, { description: "Pindah ke tabungan" })
        );

        assert.equal(created, true);
        assert.equal(transaction.type, "TRANSFER");
        assert.equal(transaction.status, "PENDING");
        assert.equal(transaction.userId, userA.id);
        assert.equal(transaction.walletId, from.id);
        assert.equal(transaction.destinationWalletId, to.id);
        assert.equal(transaction.categoryId, null);
        assert.equal(transaction.amount.toFixed(2), "25000.50");
        assert.equal(transaction.source, "WEB");
        assert.equal(transaction.description, "Pindah ke tabungan");
        assert.equal(transaction.idempotencyKey, null);
        assert.equal(typeof transaction.id, "bigint");
        assert.ok(transaction.transactionDate.getTime() >= before - 1000);
        assert.ok(transaction.transactionDate.getTime() <= Date.now() + 1000);

        const inDb = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        assert.equal(inDb.status, "PENDING");
        assert.equal(inDb.categoryId, null);
        assert.equal(inDb.cancelledAt, null);
    });

    test("saldo kedua dompet TIDAK berubah setelah transfer PENDING dibuat", async () => {
        const [from, to] = await twoWallets(); // masing-masing 1000
        await createTransfer(userA.id, transferInput(from, to, { amount: "400" }));
        await createTransfer(userA.id, transferInput(to, from, { amount: "150.25" }));

        const balances = await getWalletBalances(prisma, userA.id, [from.id, to.id]);
        assert.equal(balances.get(from.id).balance.toFixed(2), "1000.00");
        assert.equal(balances.get(to.id).balance.toFixed(2), "1000.00");
        assert.equal(balances.get(from.id).transferOut.toFixed(2), "0.00");
        assert.equal(balances.get(to.id).transferIn.toFixed(2), "0.00");
    });

    test("transfer lebih besar dari saldo sumber tetap boleh dibuat sebagai PENDING (dicek saat konfirmasi)", async () => {
        const [from, to] = await twoWallets(); // saldo sumber 1000
        const { transaction } = await createTransfer(userA.id, transferInput(from, to, { amount: "999999" }));
        assert.equal(transaction.status, "PENDING");
    });

    test("id boleh dikirim sebagai angka, dan sumber/tujuan boleh berbeda jenis dompet", async () => {
        const bank = await newWallet(userA, { type: "BANK" });
        const ewallet = await newWallet(userA, { type: "EWALLET" });
        const { transaction } = await createTransfer(userA.id, {
            walletId: Number(bank.id),
            destinationWalletId: Number(ewallet.id),
            amount: 10,
            source: "TELEGRAM",
        });

        assert.equal(transaction.walletId, bank.id);
        assert.equal(transaction.destinationWalletId, ewallet.id);
        assert.equal(transaction.source, "TELEGRAM");
    });

    test("hasil aman diserialisasi ke JSON (BigInt dan Decimal menjadi string)", async () => {
        const [from, to] = await twoWallets();
        const { transaction } = await createTransfer(userA.id, transferInput(from, to, { idempotencyKey: "tr-serial" }));
        const json = JSON.parse(JSON.stringify({ success: true, data: transaction }, jsonReplacer));

        assert.equal(json.data.id, String(transaction.id));
        assert.equal(json.data.walletId, String(from.id));
        assert.equal(json.data.destinationWalletId, String(to.id));
        assert.equal(json.data.categoryId, null);
        assert.equal(json.data.amount, "25000.50");
        assert.equal(json.data.idempotencyKey, "tr-serial");
    });
});

describe("aturan TRANSFER", () => {
    test("sumber dan tujuan yang sama ditolak 422 (termasuk bila ditulis berbeda format)", async () => {
        const [from] = await twoWallets();

        for (const [a, b] of [
            [String(from.id), String(from.id)],
            [Number(from.id), String(from.id)],
            [String(from.id), Number(from.id)],
            [` ${from.id} `, String(from.id)], // spasi di sekitar id di-trim, tetap dianggap sama
        ]) {
            await rejectsWith(
                createTransfer(userA.id, { walletId: a, destinationWalletId: b, amount: "10", source: "WEB" }),
                422,
                "TRANSFER_SAME_WALLET"
            );
        }
        assert.equal(await countTx(from.id), 0);
    });

    test("categoryId tidak boleh dikirim (kategori valid sekalipun), tetapi null dianggap tidak dikirim", async () => {
        const [from, to] = await twoWallets();

        for (const category of [incomeCat, expenseCat]) {
            await assert.rejects(
                createTransfer(userA.id, transferInput(from, to, { categoryId: String(category.id) })),
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.equal(err.code, "VALIDATION_ERROR");
                    assert.equal(err.details.field, "categoryId");
                    assert.match(err.message, /not allowed for TRANSFER/);
                    return true;
                }
            );
        }
        assert.equal(await countTx(from.id, to.id), 0);

        const { transaction } = await createTransfer(userA.id, transferInput(from, to, { categoryId: null }));
        assert.equal(transaction.categoryId, null);
    });

    test("destinationWalletId wajib; id tidak valid ditolak 400", async () => {
        const [from, to] = await twoWallets();

        for (const empty of [undefined, null]) {
            await assert.rejects(
                createTransfer(userA.id, transferInput(from, to, { destinationWalletId: empty })),
                (err) => err.statusCode === 400 && err.details.field === "destinationWalletId"
            );
        }
        for (const bad of ["abc", "0", "-1", 1.5, {}, "9223372036854775808"]) {
            await rejectsWith(createTransfer(userA.id, transferInput(from, to, { destinationWalletId: bad })), 400, "VALIDATION_ERROR");
            await rejectsWith(createTransfer(userA.id, transferInput(from, to, { walletId: bad })), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(from.id, to.id), 0);
    });

    test("nominal tidak valid ditolak 400 dan tidak ada yang tersimpan", async () => {
        const [from, to] = await twoWallets();

        for (const bad of ["0", "0.00", "-5", "abc", "12.345", "", 0.1 + 0.2, {}, [], true, undefined, null]) {
            await rejectsWith(createTransfer(userA.id, transferInput(from, to, { amount: bad })), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(from.id, to.id), 0);
    });

    test("field tidak dikenal ditolak, termasuk status, userId, dan type", async () => {
        const [from, to] = await twoWallets();

        for (const extra of [
            { status: "CONFIRMED" },
            { userId: String(userB.id) },
            { type: "INCOME" },
            { cancelledAt: "2026-11-09T00:00:00Z" },
            { sourceWalletId: String(from.id) },
            { foo: "bar" },
        ]) {
            await rejectsWith(createTransfer(userA.id, transferInput(from, to, extra)), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(from.id, to.id), 0);
    });

    test("input yang bukan objek ditolak 400", async () => {
        for (const bad of [null, undefined, "abc", 42, []]) {
            await rejectsWith(createTransfer(userA.id, bad), 400, "VALIDATION_ERROR");
        }
    });

    test("source, description, dan transactionDate divalidasi seperti INCOME/EXPENSE", async () => {
        const [from, to] = await twoWallets();

        for (const bad of ["telegram", "EMAIL", "", 1]) {
            await rejectsWith(createTransfer(userA.id, transferInput(from, to, { source: bad })), 400, "VALIDATION_ERROR");
        }
        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { description: "x".repeat(501) })), 400, "VALIDATION_ERROR");
        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { transactionDate: "2026-11-09" })), 400, "VALIDATION_ERROR");
        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { transactionDate: "2026-02-31T10:00:00Z" })), 400, "VALIDATION_ERROR");
        assert.equal(await countTx(from.id, to.id), 0);

        const date = "2026-11-09T10:30:00+07:00";
        const { transaction } = await createTransfer(userA.id, transferInput(from, to, { transactionDate: date, description: "  catatan  " }));
        assert.equal(transaction.transactionDate.getTime(), new Date(date).getTime());
        assert.equal(transaction.description, "catatan");
    });
});

describe("validasi kepemilikan dan status dompet", () => {
    test("dompet sumber milik user lain: 404, tidak ada yang tersimpan", async () => {
        const [, to] = await twoWallets();
        const foreign = await newWallet(userB);

        await rejectsWith(createTransfer(userA.id, transferInput(foreign, to)), 404, "WALLET_NOT_FOUND");
        assert.equal(await countTx(foreign.id, to.id), 0);
    });

    test("dompet tujuan milik user lain: 404, tidak ada yang tersimpan", async () => {
        const [from] = await twoWallets();
        const foreign = await newWallet(userB);

        await rejectsWith(createTransfer(userA.id, transferInput(from, foreign)), 404, "WALLET_NOT_FOUND");
        assert.equal(await countTx(from.id, foreign.id), 0);
    });

    test("kedua dompet milik user lain: 404 (user tidak bisa memindahkan dana user lain)", async () => {
        const [b1, b2] = await twoWallets(userB);

        await rejectsWith(createTransfer(userA.id, transferInput(b1, b2)), 404, "WALLET_NOT_FOUND");
        assert.equal(await countTx(b1.id, b2.id), 0);
    });

    test("dompet tidak ada: 404 yang sama dengan dompet milik user lain", async () => {
        const [from, to] = await twoWallets();

        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { destinationWalletId: "999999999" })), 404, "WALLET_NOT_FOUND");
        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { walletId: "999999999" })), 404, "WALLET_NOT_FOUND");
        assert.equal(await countTx(from.id, to.id), 0);
    });

    test("dompet sumber atau tujuan nonaktif ditolak 422", async () => {
        const [active, other] = await twoWallets();
        const inactive = await newWallet(userA, { isActive: false });

        await rejectsWith(createTransfer(userA.id, transferInput(inactive, active)), 422, "WALLET_INACTIVE");
        await rejectsWith(createTransfer(userA.id, transferInput(active, inactive)), 422, "WALLET_INACTIVE");
        await rejectsWith(createTransfer(userA.id, transferInput(inactive, inactive)), 422, "TRANSFER_SAME_WALLET");
        assert.equal(await countTx(active.id, other.id, inactive.id), 0);
    });
});

describe("idempotency {userId}:{key} untuk TRANSFER", () => {
    test("kunci disimpan sebagai '{userId}:{key}' tetapi dikembalikan tanpa awalan", async () => {
        const [from, to] = await twoWallets();
        const { transaction } = await createTransfer(userA.id, transferInput(from, to, { idempotencyKey: "tg:1:200" }));

        assert.equal(transaction.idempotencyKey, "tg:1:200");

        const inDb = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        assert.equal(inDb.idempotencyKey, `${userA.id}:tg:1:200`);
    });

    test("permintaan ulang dengan kunci dan isi sama mengembalikan transfer yang sama (tanpa duplikat)", async () => {
        const [from, to] = await twoWallets();
        const input = transferInput(from, to, { idempotencyKey: "tr-retry", description: "bayar" });

        const first = await createTransfer(userA.id, input);
        const second = await createTransfer(userA.id, input);
        const third = await createTransfer(userA.id, { ...input, amount: 25000.5 });

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(third.created, false);
        assert.equal(second.transaction.id, first.transaction.id);
        assert.equal(third.transaction.id, first.transaction.id);
        assert.equal(await countTx(from.id, to.id), 1);
    });

    test("kunci sama dengan isi berbeda ditolak 409 (nominal, tujuan, arah dibalik, deskripsi, source)", async () => {
        const [from, to] = await twoWallets();
        const third = await newWallet(userA);
        const input = transferInput(from, to, { idempotencyKey: "tr-conflict", description: "asli" });
        const first = await createTransfer(userA.id, input);

        const variants = [
            { ...input, amount: "25000.51" },
            { ...input, destinationWalletId: String(third.id) },
            { ...input, walletId: input.destinationWalletId, destinationWalletId: input.walletId }, // arah dibalik
            { ...input, description: "beda" },
            { ...input, description: undefined },
            { ...input, source: "TELEGRAM" },
        ];

        for (const variant of variants) {
            await rejectsWith(createTransfer(userA.id, variant), 409, "IDEMPOTENCY_CONFLICT");
        }

        assert.equal(await countTx(from.id, to.id), 1);
        assert.equal(await countTx(third.id), 0);
        const stillThere = await prisma.transaction.findUnique({ where: { id: first.transaction.id } });
        assert.equal(stillThere.amount.toFixed(2), "25000.50");
    });

    test("kunci yang sudah dipakai INCOME ditolak 409 untuk TRANSFER, dan sebaliknya", async () => {
        const [from, to] = await twoWallets();

        const income = await createIncome(userA.id, {
            walletId: String(from.id),
            categoryId: String(incomeCat.id),
            amount: "25000.50",
            source: "WEB",
            idempotencyKey: "cross-1",
        });
        assert.equal(income.created, true);
        await rejectsWith(createTransfer(userA.id, transferInput(from, to, { idempotencyKey: "cross-1" })), 409, "IDEMPOTENCY_CONFLICT");

        await createTransfer(userA.id, transferInput(from, to, { idempotencyKey: "cross-2" }));
        await rejectsWith(
            createIncome(userA.id, {
                walletId: String(from.id),
                categoryId: String(incomeCat.id),
                amount: "25000.50",
                source: "WEB",
                idempotencyKey: "cross-2",
            }),
            409,
            "IDEMPOTENCY_CONFLICT"
        );
    });

    test("kunci yang sama dari dua user berbeda tidak bertabrakan dan tidak saling melihat", async () => {
        const [a1, a2] = await twoWallets(userA);
        const [b1, b2] = await twoWallets(userB);

        const a = await createTransfer(userA.id, transferInput(a1, a2, { idempotencyKey: "shared-tr" }));
        const b = await createTransfer(userB.id, transferInput(b1, b2, { idempotencyKey: "shared-tr" }));

        assert.equal(a.created, true);
        assert.equal(b.created, true);
        assert.notEqual(a.transaction.id, b.transaction.id);
        assert.equal(a.transaction.userId, userA.id);
        assert.equal(b.transaction.userId, userB.id);

        // User B mengirim ulang kunci yang sama untuk dompet user A: tidak mengembalikan data user A
        await rejectsWith(createTransfer(userB.id, transferInput(a1, a2, { idempotencyKey: "shared-tr" })), 409, "IDEMPOTENCY_CONFLICT");
    });

    test("tanpa kunci: dua permintaan identik membuat dua transfer", async () => {
        const [from, to] = await twoWallets();
        const first = await createTransfer(userA.id, transferInput(from, to));
        const second = await createTransfer(userA.id, transferInput(from, to));

        assert.notEqual(first.transaction.id, second.transaction.id);
        assert.equal(await countTx(from.id, to.id), 2);
    });

    test("balapan: 8 permintaan bersamaan dengan kunci dan isi sama -> tepat 1 transfer", async () => {
        const [from, to] = await twoWallets();
        const input = transferInput(from, to, { idempotencyKey: "tr-race-1" });

        const results = await Promise.allSettled(Array.from({ length: 8 }, () => createTransfer(userA.id, input)));
        const failures = results.filter((r) => r.status === "rejected");

        assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join(" | "));
        const values = results.map((r) => r.value);
        assert.equal(values.filter((v) => v.created).length, 1);
        assert.equal(new Set(values.map((v) => v.transaction.id)).size, 1);
        assert.equal(await countTx(from.id, to.id), 1);
    });

    test("balapan lintas pasangan dompet: kunci sama, tujuan berbeda -> tepat 1 berhasil, 1 ditolak 409", async () => {
        const [from, toOne] = await twoWallets();
        const toTwo = await newWallet(userA);

        const results = await Promise.allSettled([
            createTransfer(userA.id, transferInput(from, toOne, { idempotencyKey: "tr-race-2" })),
            createTransfer(userA.id, transferInput(from, toTwo, { idempotencyKey: "tr-race-2" })),
        ]);

        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r) => r.status === "rejected");
        assert.equal(ok.length, 1);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].reason.code, "IDEMPOTENCY_CONFLICT");
        assert.equal(await countTx(from.id, toOne.id, toTwo.id), 1);
    });
});

describe("penguncian dompet dan concurrency", () => {
    test("transfer A->B dan B->A bersamaan (12 permintaan) selesai semua tanpa deadlock", async () => {
        const [a, b] = await twoWallets();

        const jobs = Array.from({ length: 12 }, (_, i) =>
            i % 2 === 0
                ? createTransfer(userA.id, transferInput(a, b, { amount: "10" }))
                : createTransfer(userA.id, transferInput(b, a, { amount: "10" }))
        );
        const results = await Promise.allSettled(jobs);
        const failures = results.filter((r) => r.status === "rejected");

        assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join(" | "));
        assert.equal(await countTx(a.id, b.id), 12);
    });

    // Memastikan pembuatan transfer menunggu selama transaksi lain memegang kunci dompet
    // tujuan (atau sumber). Catatan: InnoDB juga membuat INSERT menunggu lewat pengecekan
    // foreign key, jadi tes ini menjamin PERILAKU menunggu, bukan membedakan mekanismenya.
    // Penguncian eksplisit kedua dompet dibuktikan oleh tes deadlock di atas dan tes
    // kepemilikan/status dompet (keduanya gagal bila dompet tujuan tidak ikut dikunci).
    for (const [label, pickLocked] of [
        ["tujuan", (from, to) => to],
        ["sumber", (from) => from],
    ]) {
        test(`pembuatan transfer menunggu selama dompet ${label} dikunci transaksi lain`, async () => {
            const [from, to] = await twoWallets();
            const lockedWallet = pickLocked(from, to);

            let release;
            const released = new Promise((resolve) => (release = resolve));
            let markLocked;
            const lockedSignal = new Promise((resolve) => (markLocked = resolve));

            const holder = runInTransaction(async (tx) => {
                await lockWallets(tx, userA.id, [lockedWallet.id]);
                markLocked();
                await released;
            });

            let attempt;
            let settled = false;

            try {
                await lockedSignal;
                attempt = createTransfer(userA.id, transferInput(from, to)).then((value) => {
                    settled = true;
                    return value;
                });

                await sleep(400);
                assert.equal(settled, false, `transfer tidak menunggu kunci dompet ${label}`);
                assert.equal(await countTx(from.id, to.id), 0);
            } finally {
                release();
            }

            const result = await attempt;
            await holder;

            assert.equal(result.created, true);
            assert.equal(await countTx(from.id, to.id), 1);
        });
    }

    test("pembuatan transfer tidak menunggu dompet lain yang tidak terlibat", async () => {
        const [from, to] = await twoWallets();
        const unrelated = await newWallet(userA);

        let release;
        const released = new Promise((resolve) => (release = resolve));
        let markLocked;
        const lockedSignal = new Promise((resolve) => (markLocked = resolve));

        const holder = runInTransaction(async (tx) => {
            await lockWallets(tx, userA.id, [unrelated.id]);
            markLocked();
            await released;
        });

        try {
            await lockedSignal;
            const started = Date.now();
            const result = await createTransfer(userA.id, transferInput(from, to));
            assert.equal(result.created, true);
            assert.ok(Date.now() - started < 3000, "transfer menunggu dompet yang tidak terlibat");
        } finally {
            release();
            await holder;
        }
    });
});
