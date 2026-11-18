// Bentuk data yang dikirim ke klien HTTP.
// userId dibuang: klien tidak perlu tahu, dan itu menghindari kebocoran id pengguna.
// BigInt -> string dan Decimal -> string 2 desimal ditangani oleh "json replacer" di app.js.
export function presentTransactionForClient(transaction) {
    const { userId, ...rest } = transaction;
    return rest;
}

// Hasil confirm/cancel dari service: { transaction, balances: [{ walletId, balance }] }.
// Hanya field yang dikenal yang diteruskan ke klien (whitelist), bukan seluruh objek hasil service.
export function presentResultForClient({ transaction, balances }) {
    return {
        transaction: presentTransactionForClient(transaction),
        balances: balances.map(({ walletId, balance }) => ({ walletId, balance })),
    };
}

// Daftar transaksi: setiap elemen berbentuk sama dengan hasil create/confirm (tanpa userId).
export function presentTransactionListForClient(transactions) {
    return transactions.map(presentTransactionForClient);
}
