import { Prisma } from "@prisma/client";

// Dipasang sekali di app.js lewat: app.set("json replacer", jsonReplacer)
// sehingga SEMUA res.json() otomatis aman, tanpa perlu mengingat konversi manual.
//
// - BigInt  -> string  (JSON tidak bisa menyimpan BigInt, tanpa ini Express error)
// - Decimal -> string dengan 2 desimal, misalnya "25000.00" (tidak pernah jadi float)
//
// Catatan: harus berupa `function` biasa (bukan arrow function) karena memakai `this`.
// `this[key]` adalah nilai ASLI sebelum JSON.stringify memanggil toJSON().
export function jsonReplacer(key, value) {
    const original = this[key];

    if (typeof original === "bigint") {
        return original.toString();
    }

    if (Prisma.Decimal.isDecimal(original)) {
        return original.toFixed(2);
    }

    return value;
}
