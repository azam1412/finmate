import { Prisma } from "@prisma/client";
import prisma from "../config/database.js";
import AppError from "../utils/AppError.js";
import { runInTransaction, lockWallets } from "../utils/dbTransaction.js";
import {
    assertOnlyFields,
    parseId,
    parseMoney,
    parseSource,
    parseDescription,
    parseTransactionDate,
    parseIdempotencyKey,
} from "../utils/validators.js";

// PEMBUATAN TRANSAKSI INCOME, EXPENSE (Stage 2.2b) DAN TRANSFER (Stage 2.2c)
//
// Aturan yang ditegakkan di sini:
//  - Nominal harus lebih besar dari nol (Prisma.Decimal, maksimal 2 desimal).
//  - Dompet harus milik user dan aktif (dompet milik user lain = "tidak ditemukan").
//  - INCOME/EXPENSE: kategori harus milik user atau global (userId NULL), dan tipenya
//    sama dengan tipe transaksi.
//  - TRANSFER: dompet sumber (walletId) dan tujuan (destinationWalletId) harus berbeda,
//    keduanya milik user dan aktif, dan categoryId TIDAK boleh dikirim.
//  - Status awal SELALU PENDING. Saldo tidak berubah sampai transaksi dikonfirmasi (Stage 2.2d).
//  - userId HANYA dari parameter pertama (dari req.user.id), tidak pernah dari input.
//
// Idempotency: kunci dari klien disimpan sebagai "{userId}:{key}" supaya kunci yang sama
// dari dua user tidak bertabrakan. Permintaan ulang dengan kunci dan isi yang sama
// mengembalikan transaksi yang sudah ada (created: false), bukan membuat duplikat.
// Kunci yang sama dengan isi berbeda ditolak 409.

const SIMPLE_ALLOWED_FIELDS = [
    "walletId",
    "categoryId",
    "amount",
    "description",
    "transactionDate",
    "source",
    "idempotencyKey",
];

// "categoryId" ada di daftar ini hanya supaya penolakannya memberi pesan yang jelas
// ("categoryId is not allowed for TRANSFER"), bukan "Unknown field".
const TRANSFER_ALLOWED_FIELDS = [
    "walletId",
    "destinationWalletId",
    "categoryId",
    "amount",
    "description",
    "transactionDate",
    "source",
    "idempotencyKey",
];

const isProvided = (value) => value !== undefined && value !== null;

function requireField(input, name) {
    if (!isProvided(input[name])) {
        throw new AppError(400, "VALIDATION_ERROR", `${name} is required`, { field: name });
    }
}

// Field yang sama untuk semua tipe transaksi.
function parseCommonFields(input) {
    return {
        amount: parseMoney(input.amount, "amount"),
        source: parseSource(input.source),
        description: isProvided(input.description) ? parseDescription(input.description) : null,
        // undefined = klien tidak mengirim tanggal (dipakai waktu sekarang, dan tidak ikut dibandingkan saat replay)
        transactionDate: isProvided(input.transactionDate)
            ? parseTransactionDate(input.transactionDate)
            : undefined,
        idempotencyKey: isProvided(input.idempotencyKey)
            ? parseIdempotencyKey(input.idempotencyKey)
            : undefined,
    };
}

function parseSimpleInput(type, input) {
    assertOnlyFields(input, SIMPLE_ALLOWED_FIELDS);

    for (const name of ["walletId", "categoryId", "amount", "source"]) {
        requireField(input, name);
    }

    return {
        type,
        walletId: parseId(input.walletId, "walletId"),
        destinationWalletId: null,
        categoryId: parseId(input.categoryId, "categoryId"),
        ...parseCommonFields(input),
    };
}

function parseTransferInput(input) {
    assertOnlyFields(input, TRANSFER_ALLOWED_FIELDS);

    if (isProvided(input.categoryId)) {
        throw new AppError(400, "VALIDATION_ERROR", "categoryId is not allowed for TRANSFER", {
            field: "categoryId",
        });
    }

    for (const name of ["walletId", "destinationWalletId", "amount", "source"]) {
        requireField(input, name);
    }

    const walletId = parseId(input.walletId, "walletId");
    const destinationWalletId = parseId(input.destinationWalletId, "destinationWalletId");

    if (walletId === destinationWalletId) {
        throw new AppError(
            422,
            "TRANSFER_SAME_WALLET",
            "Source and destination wallet must be different"
        );
    }

    return {
        type: "TRANSFER",
        walletId,
        destinationWalletId,
        categoryId: null,
        ...parseCommonFields(input),
    };
}

const storedKeyFor = (userId, key) => `${userId}:${key}`;

// Kunci dikembalikan ke klien tanpa awalan userId (detail penyimpanan internal).
function present(row) {
    const prefix = `${row.userId}:`;

    return {
        ...row,
        idempotencyKey: row.idempotencyKey?.startsWith(prefix)
            ? row.idempotencyKey.slice(prefix.length)
            : row.idempotencyKey,
    };
}

function isSameRequest(existing, request) {
    return (
        existing.type === request.type &&
        existing.walletId === request.walletId &&
        (existing.destinationWalletId ?? null) === (request.destinationWalletId ?? null) &&
        (existing.categoryId ?? null) === (request.categoryId ?? null) &&
        new Prisma.Decimal(existing.amount).equals(request.amount) &&
        (existing.description ?? null) === request.description &&
        existing.source === request.source &&
        (request.transactionDate === undefined ||
            existing.transactionDate.getTime() === request.transactionDate.getTime())
    );
}

// Permintaan ulang dengan kunci yang sama. Transaksi lama dikembalikan apa adanya,
// termasuk statusnya saat ini (bisa sudah CONFIRMED atau CANCELLED).
function replay(existing, request) {
    if (!isSameRequest(existing, request)) {
        throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with different data"
        );
    }

    return { transaction: present(existing), created: false };
}

async function assertCategoryUsable(tx, userId, categoryId, type) {
    const category = await tx.category.findFirst({
        where: { id: categoryId, OR: [{ userId }, { userId: null }] },
        select: { id: true, type: true },
    });

    // Kategori yang tidak ada dan kategori milik user lain memberi respon yang sama.
    if (!category) {
        throw new AppError(404, "CATEGORY_NOT_FOUND", "Category not found");
    }

    if (category.type !== type) {
        throw new AppError(
            422,
            "CATEGORY_TYPE_MISMATCH",
            `A ${category.type} category cannot be used for an ${type} transaction`
        );
    }
}

// Alur bersama semua tipe: cek kunci idempotency, lalu satu database transaction yang
// mengunci dompet, memvalidasi, dan menyimpan transaksi berstatus PENDING.
async function createPending(userIdInput, request) {
    const userId = BigInt(userIdInput);
    const storedKey = request.idempotencyKey ? storedKeyFor(userId, request.idempotencyKey) : null;

    // Jalur cepat: kunci sudah pernah dipakai.
    if (storedKey) {
        const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: storedKey } });

        if (existing) {
            return replay(existing, request);
        }
    }

    try {
        const created = await runInTransaction(async (tx) => {
            // Mengunci semua dompet yang terlibat sekaligus memvalidasi kepemilikan dan status aktif.
            // lockWallets mengurutkan id dari yang terkecil, jadi transfer A->B dan B->A
            // yang bersamaan mengunci dalam urutan yang sama dan tidak saling menunggu (deadlock).
            const walletIds = request.destinationWalletId
                ? [request.walletId, request.destinationWalletId]
                : [request.walletId];
            await lockWallets(tx, userId, walletIds);

            if (request.type !== "TRANSFER") {
                await assertCategoryUsable(tx, userId, request.categoryId, request.type);
            }

            return tx.transaction.create({
                data: {
                    userId,
                    walletId: request.walletId,
                    destinationWalletId: request.destinationWalletId ?? null,
                    categoryId: request.categoryId ?? null,
                    type: request.type,
                    amount: request.amount,
                    description: request.description,
                    transactionDate: request.transactionDate ?? new Date(),
                    status: "PENDING",
                    source: request.source,
                    idempotencyKey: storedKey,
                },
            });
        });

        return { transaction: present(created), created: true };
    } catch (error) {
        // Jalur balapan: dua permintaan dengan kunci sama lolos pengecekan awal bersamaan,
        // dan yang kedua ditolak oleh unique constraint. Anggap sebagai permintaan ulang.
        if (
            storedKey &&
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            const existing = await prisma.transaction.findUnique({
                where: { idempotencyKey: storedKey },
            });

            if (existing) {
                return replay(existing, request);
            }
        }

        throw error;
    }
}

/**
 * Membuat transaksi INCOME berstatus PENDING.
 *
 * @param userId BigInt, dari req.user.id
 * @param input  { walletId, categoryId, amount, source, description?, transactionDate?, idempotencyKey? }
 * @returns { transaction, created }  created=false jika ini permintaan ulang dengan kunci yang sama
 */
export async function createIncome(userId, input) {
    return createPending(userId, parseSimpleInput("INCOME", input));
}

/**
 * Membuat transaksi EXPENSE berstatus PENDING. Parameter dan hasil sama dengan createIncome.
 * Saldo tidak dicek di sini karena PENDING belum memengaruhi saldo; pengecekan "saldo tidak
 * boleh minus" dilakukan saat konfirmasi (Stage 2.2d).
 */
export async function createExpense(userId, input) {
    return createPending(userId, parseSimpleInput("EXPENSE", input));
}

/**
 * Membuat transaksi TRANSFER berstatus PENDING antar dua dompet milik user.
 *
 * @param userId BigInt, dari req.user.id
 * @param input  { walletId (sumber), destinationWalletId (tujuan), amount, source,
 *                 description?, transactionDate?, idempotencyKey? }
 *               categoryId tidak boleh dikirim.
 * @returns { transaction, created }
 *
 * Seperti EXPENSE, saldo sumber tidak dicek di sini; pengecekannya dilakukan saat konfirmasi.
 */
export async function createTransfer(userId, input) {
    return createPending(userId, parseTransferInput(input));
}
