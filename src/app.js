import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import prisma from "./config/database.js"; 

const app = express();
const PORT = process.env.PORT || 3000;

//middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Halaman Utama
app.get("/", (req, res) => {
    res.json({ 
        success: true,
        message: "Welcome to FinMate API"
    });
});

// Health Check Server and Database
app.get("/health", async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;

        res.status(200).json({
            success: true,
            message: "Server and Database are healthy",
            database: "Database connection successful",
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Health check failed:", error);

        res.status(500).json({
            success: false,
            message: "Error occurred while checking health",
            database: "Database connection failed",
            error: error.message,
            timestamp: new Date().toISOString(),
        });
    }
});

//Menjalankan Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});