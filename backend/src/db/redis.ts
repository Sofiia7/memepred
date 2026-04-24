import { createClient } from 'redis'
import { REDIS_URL } from '../config.js'

export const redis = createClient({ url: REDIS_URL })

redis.on('error', (err) => console.error('Redis error:', err))
