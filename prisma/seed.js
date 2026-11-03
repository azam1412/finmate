
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Memulai proses seeding Finmate...");

  // 1. Membuat akun pengguna
  let user = await prisma.user.findFirst({
    where: { name: "Pemilik Finmate" },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        name: "Pemilik Finmate",
      },
    });
  }

  console.log("Akun pengguna berhasil disiapkan.");

  // 2. Membuat dompet
  const wallets = [
    { name: "Tunai", type: "CASH" },
    { name: "Bank", type: "BANK" },
    { name: "E-Wallet", type: "EWALLET" },
    { name: "Tabungan", type: "SAVINGS" },
  ];

  for (const wallet of wallets) {
    const existing = await prisma.wallet.findFirst({
      where: {
        userId: user.id,
        name: wallet.name,
      },
    });

    if (!existing) {
      await prisma.wallet.create({
        data: {
          userId: user.id,
          name: wallet.name,
          type: wallet.type,
          initialBalance: 0,
        },
      });
    }
  }

  console.log("Dompet berhasil disiapkan.");

  // 3. Membuat kategori pemasukan dan pengeluaran
  const categories = [
    // Pemasukan
    { name: "Gaji", type: "INCOME" },
    { name: "Freelance", type: "INCOME" },
    { name: "Bonus", type: "INCOME" },
    { name: "Hadiah", type: "INCOME" },
    { name: "Pemasukan Lainnya", type: "INCOME" },

    // Pengeluaran
    { name: "Makanan & Minuman", type: "EXPENSE" },
    { name: "Transportasi", type: "EXPENSE" },
    { name: "Belanja", type: "EXPENSE" },
    { name: "Tagihan", type: "EXPENSE" },
    { name: "Kesehatan", type: "EXPENSE" },
    { name: "Pendidikan", type: "EXPENSE" },
    { name: "Hiburan", type: "EXPENSE" },
    { name: "Pengeluaran Lainnya", type: "EXPENSE" },
  ];

  for (const category of categories) {
    const existing = await prisma.category.findFirst({
      where: {
        userId: null,
        name: category.name,
        type: category.type,
      },
    });

    if (!existing) {
      await prisma.category.create({
        data: {
          userId: null,
          name: category.name,
          type: category.type,
        },
      });
    }
  }

  console.log("Kategori berhasil disiapkan.");
  console.log("Seeding Finmate selesai!");
}

main()
  .catch((error) => {
    console.error("Seeding gagal:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
