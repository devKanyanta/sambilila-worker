// lib/db.ts
import { PrismaClient } from '../prisma/src/lib/generated/prisma/client.js';
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from 'pg';
const connectionString = process.env.DATABASE_URL;
// Clever Cloud has limited connections (default 5-20)
// We need to configure the pg pool properly
const pool = new Pool({
    connectionString,
    // Clever Cloud recommendations:
    max: 3, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 5000, // Return an error after 5 seconds if connection not established
    maxUses: 7500, // Close and replace a connection after it's been used 7500 times
});
// Create the adapter with the pool
const adapter = new PrismaPg(pool);
const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma ??
    new PrismaClient({
        adapter: adapter,
        log: ["error", "warn"],
    });
// Handle connection cleanup
const cleanup = async () => {
    console.log('Cleaning up database connections...');
    await prisma.$disconnect();
    await pool.end();
};
// Register cleanup on exit
if (process.env.NODE_ENV !== 'test') {
    process.on('beforeExit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
// Prevent hot reload from creating new instances in development
if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
export default prisma;
