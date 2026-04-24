import pg from 'pg'
import { DATABASE_URL } from '../config.js'

const pool = new pg.Pool({ connectionString: DATABASE_URL })

export { pool as pg }
