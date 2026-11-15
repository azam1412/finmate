// Bentuk transaksi yang dikirim ke klien HTTP.
// userId dibuang: klien tidak perlu tahu, dan itu menghindari kebocoran id pengguna.
// BigInt -> string dan Decimal -> string 2 desimal ditangani oleh "json replacer" di app.js.
export function presentTransactionForClient(transaction) {
    const { userId, ...rest } = transaction;
    return rest;
}
