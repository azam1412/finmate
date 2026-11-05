import { Router } from "express";
import userContext from "../middleware/userContext.js";

// Semua route di bawah /api memerlukan pengguna (req.user) yang valid.
// Modul berikutnya (wallets, categories, transactions) didaftarkan di sini.
const router = Router();

router.use(userContext);

// Pemeriksaan: siapa pengguna yang sedang aktif? Juga membuktikan id BigInt terkirim sebagai string.
router.get("/me", (req, res) => {
    res.json({
        success: true,
        data: {
            id: req.user.id,
            name: req.user.name,
        },
    });
});

export default router;
