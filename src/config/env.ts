import "dotenv/config";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret= process.env.JWT_SECRET;
const jwt_expires = process.env.JWT_EXPIRES_IN;
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const redisUrl = process.env.REDIS_URL;

if(!databaseUrl){
    throw new Error("DATABASE_URL is not defined");
}

if(!jwtSecret){
    throw new Error("JWT_SECRET is not defined");
}

if(!jwt_expires){
    throw new Error("JWT_EXPIRES_IN is not defined");
}

export const env = {
    port,
    databaseUrl,
    jwtSecret,
    jwt_expires,
    publicBaseUrl,
    redisUrl
}