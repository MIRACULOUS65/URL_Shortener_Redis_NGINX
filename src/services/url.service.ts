import { env } from "../config/env.js";
import { createUrl, findByCode, findByUserId } from "../repositories/url.repository.js";
import { generateCode } from "../utils/generateCode.js";
import { redisClient } from "../db/redis.js";

const CACHE_DEBUG = process.env.CACHE_DEBUG === "true";

function logCache(message: string): void {
    if (CACHE_DEBUG) {
        console.info(message);
    }
}

const URL_CACHE_PREFIX = "url:redirect:v1:";
const URL_CACHE_TTL_SECONDS = 300; // 5 minutes


export async function shortenUrl(
    originalUrl: string,
    userId: number
){
    if(!originalUrl){
        throw new Error("url is required");
    }

    let code =generateCode();

    let existing = await findByCode(code);

    while(existing){
        code = generateCode();
        existing = await findByCode(code);
    } // for double check if the newly generated even exists

    const url =  await createUrl (code,originalUrl,userId);

    return{
        id:url.id,
        code:url.code,
        //direct local a[pplication URL : Phase 2
        // shortUrl:`http://localhost:3000/${url.code}`
        
        // phase 6: public URL served through NGINX

        shortUrl: `${env.publicBaseUrl}/${url.code}`
    };
}


export async function resolveUrl(code: string): Promise<string | null> {
    const cacheKey = `${URL_CACHE_PREFIX}${code}`;

    // Step 1: Try Redis first.
    if (redisClient?.isReady) {
        try {
            const cachedUrl = await redisClient.get(cacheKey);

            if (cachedUrl !== null) {
                logCache(`[URL cache] HIT code=${code}`);
                return cachedUrl;
            }

            logCache(`[URL cache] MISS code=${code}`);
        } catch (error) {
            // Cache failure must not prevent a redirect.
            console.warn(
                "[URL cache] Read failed; falling back to PostgreSQL",
                error
            );
        }
    } else {
        logCache(`[URL cache] BYPASS code=${code}; Redis not ready`);
    }

    // Step 2: Cache miss or unavailable Redis.
    const url = await findByCode(code);

    if (!url) {
        // We are deliberately not caching 404 results in this experiment.
        return null;
    }

    // Step 3: Populate Redis for subsequent requests.
    if (redisClient?.isReady) {
        try {
            await redisClient.set(
                cacheKey,
                url.originalUrl,
                { EX: URL_CACHE_TTL_SECONDS }
            );

            logCache(`[URL cache] STORED code=${code}`);
        } catch (error) {
            // PostgreSQL already returned the destination.
            // Redis write failure must not break the redirect.
            console.warn(
                "[URL cache] Write failed; returning PostgreSQL result",
                error
            );
        }
    }

    // Step 4: Return the database result.
    return url.originalUrl;
}


export async function getUserUrls(userId: number) {
    return await findByUserId(userId);
}