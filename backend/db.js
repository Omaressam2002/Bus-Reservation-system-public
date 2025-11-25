
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();  

const db = mysql.createPool({
  host: '127.0.0.1', // instead of 'localhost'
  user: 'root',
  password: 'Omar2002',
  database: 'bus_reservation_system'
});

export default db;

