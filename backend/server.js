import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import db from './db.js';

const app = express();
const PORT = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Session
app.use(session({
  secret: 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60,
  }
}));


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/get-trips', async (req, res) => {
  const { tier } = req.query;
  try {
    const [rows] = await db.query(
      "SELECT * FROM trips WHERE tier = ?",
      [tier]
    );
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error" });
  }
});



app.post('/api/book-trip', async (req, res) => {
  const { trip_id } = req.body;

  if (!req.session.user.id) {
    return res.status(401).json({ message: 'You must be logged in to book.' });
  }

  try {
    const userId = req.session.user.id;

    // 1. Get total_seats and seats_left for the trip
    const [[tripInfo]] = await db.query(`
      SELECT buses.total_seats, trips.seats_left
      FROM trips
      JOIN buses ON trips.bus_id = buses.bus_id
      WHERE trips.trip_id = ?
    `, [trip_id]);

    if (!tripInfo) {
      return res.status(404).json({ message: 'Trip not found.' });
    }

    const { total_seats, seats_left } = tripInfo;


    if (seats_left <= 0) {
      return res.status(400).json({ message: 'Trip is fully booked.' });
    }


    // 2. Calculate the seat number to assign
    const seatNumber = total_seats - seats_left + 1;


    // 3. Insert reservation
    await db.query(
      'INSERT INTO reservations (user_id, trip_id, seat_number) VALUES (?, ?, ?)',
      [userId, trip_id, seatNumber]
    );


    // 4. Update seats_left by decrementing
    await db.query(
      'UPDATE trips SET seats_left = seats_left - 1 WHERE trip_id = ?',
      [trip_id]
    );



    res.json({
      message: `Trip booked successfully. Assigned seat: ${seatNumber}`,
      seatNumber
    });
  } catch (err) {
    console.error('Booking error:', err );
    res.status(500).json({ message: 'Booking failed.' });
  }
});



app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/signup.html'));
});
app.get('/routes', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/routes.html'));
});

// Register
app.post('/api/register', async (req, res) => {
  const { full_name, email, password } = req.body;

  if (!full_name || !email || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
      [full_name, email, hashedPassword]
    );

    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    console.error('Registration error:', err);

    if (err.code === 'ER_DUP_ENTRY') {
      if (err.sqlMessage.includes('full_name')) {
        return res.status(400).json({ message: 'Username is already taken.' });
      } else if (err.sqlMessage.includes('email')) {
        return res.status(400).json({ message: 'Email is already taken.' });
      }
    }

    res.status(500).json({ message: 'Registration failed.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { name, password } = req.body;

  if (!name || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const [users] = await db.query('SELECT * FROM users WHERE full_name = ?', [name]);

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const user = users[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // Set session
    req.session.user = {
      id: user.user_id,
      name: user.full_name,
      email: user.email,
    };

    res.json({ message: 'Login successful.', user: req.session.user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Login failed.' });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        trips.trip_id, 
        trips.source, 
        trips.destination,
        trips.departure_time, 
        trips.arrival_time, 
        buses.total_seats,
        IFNULL(
          (SELECT COUNT(*) FROM reservations WHERE reservations.trip_id = trips.trip_id),
          0
        ) AS reserved_seats,
        buses.total_seats - IFNULL(
          (SELECT COUNT(*) FROM reservations WHERE reservations.trip_id = trips.trip_id),
          0
        ) AS available_seats
      FROM trips
      JOIN buses ON trips.bus_id = buses.bus_id
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching trips' });
  }
});


app.get('/api/routes', async (req, res) => {
  const tripId = req.query.trip_id;
  console.log("[DEBUG] /api/routes called with trip_id:", tripId);

  let sql = `
    SELECT 
      trips.trip_id,
      trips.trip_date,
      trips.source,
      trips.destination,
      trips.departure_time,
      trips.arrival_time,
      trips.trip_price,
      trips.tier,
      buses.total_seats,
      buses.bus_id,
      (SELECT COUNT(*) FROM reservations WHERE reservations.trip_id = trips.trip_id) AS reserved_seats
    FROM trips
    JOIN buses ON trips.bus_id = buses.bus_id
  `;

  const params = [];

  if (tripId && !isNaN(tripId)) {
    sql += ` WHERE trips.trip_id = ?`;
    params.push(tripId);
  } else {
    sql += ` ORDER BY trips.trip_date ASC`;
  }

  console.log("[DEBUG] Executing SQL:", sql);
  console.log("[DEBUG] With parameters:", params);

  try {
    const [results] = await db.query(sql, params);

    const formatted = results.map(r => ({
      ...r,
      available_seats: r.total_seats - r.reserved_seats
    }));

    console.log("[DEBUG] Sending response JSON:", formatted);
    res.json(formatted);
  } catch (err) {
    console.error("[ERROR] DB query failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get current session
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed.' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully.' });
  });
});

app.get('/api/reserved-seats', async (req, res) => {
  const tripId = req.query.trip_id;
  console.log("[DEBUG] /api/reserved-seats called with trip_id:", tripId);

  if (!tripId) {
    return res.status(400).json({ message: 'Trip ID is required.' });
  }

  try {
    // Get reserved seat numbers
    const [reservedRows] = await db.query(
      'SELECT seat_number FROM reservations WHERE trip_id = ?',
      [tripId]
    );

    // Get total seats from buses table via join
    const [tripRows] = await db.query(
      `SELECT b.total_seats 
       FROM trips t 
       JOIN buses b ON t.bus_id = b.bus_id 
       WHERE t.trip_id = ?`,
      [tripId]
    );

    if (tripRows.length === 0) {
      return res.status(404).json({ message: 'Trip not found or no bus assigned.' });
    }

    const reservedSeats = reservedRows.map(row => row.seat_number);
    const totalSeats = tripRows[0].total_seats;

    res.json({
      reserved: reservedSeats,
      totalSeats: totalSeats
    });
  } catch (err) {
    console.error('Error fetching reserved seats and total seats:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});
app.get('/api/user-trips', async (req, res) => {
  const userId = req.session?.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    const [rows] = await db.execute(
      `
      SELECT 
        t.trip_id,
        t.source,
        t.destination,
        t.trip_date,
        t.departure_time,
        t.arrival_time,
        t.tier,
        b.plate_id,
        COUNT(r.reservation_id) AS seats_booked
      FROM reservations r
      JOIN trips t ON r.trip_id = t.trip_id
      JOIN buses b ON t.bus_id = b.bus_id
      WHERE r.user_id = ?
      GROUP BY t.trip_id, t.source, t.destination, t.trip_date, t.departure_time, t.arrival_time, t.tier, b.plate_id
      ORDER BY t.trip_date DESC, t.departure_time DESC
      `,
      [userId]
    );

    const now = new Date();
    const upcoming = [];
    const previous = [];

    for (const row of rows) {
      console.log("Row data:", row);
      const tripDateStr = row.trip_date.toISOString().split('T')[0]; // "2025-05-31"
      const departureDateTime = new Date(`${tripDateStr}T${row.departure_time}`);
      const arrivalDateTime = new Date(`${tripDateStr}T${row.arrival_time}`);
      

      console.log("Departure DateTime:", departureDateTime);
      console.log("Arrival DateTime:", arrivalDateTime);

      const trip = {
        trip_id: row.trip_id,
        source: row.source,
        destination: row.destination,
        departure_time: departureDateTime.toISOString(),
        arrival_time: arrivalDateTime.toISOString(),
        tier: row.tier,
        seats_booked: row.seats_booked,
        plate_id: row.plate_id
      };

      if (departureDateTime >= now) {
        upcoming.push(trip);
      } else {
        previous.push(trip);
      }
    }

    res.json({ upcoming, previous });

  } catch (err) {
    console.error('Error fetching user trips:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reserve-trip', async (req, res) => {
  const trip_id = req.body.trip_id;
  const seat_number = req.body.seat_number;
  const meal = req.body.meal;
  console.log("[DEBUG] /api/reserve-trip called with trip_id:", trip_id, "seat_number:", seat_number, "meal:", meal);

  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ message: 'You must be logged in to reserve a trip.' });
  }

  try {
    const userId = req.session.user.id;
    console.log("[DEBUG] User ID from session:", userId);

    // Check if the seat is already reserved
    const [existingReservation] = await db.query(
      'SELECT * FROM reservations WHERE trip_id = ? AND seat_number = ?',
      [trip_id, seat_number]
    );

    if (existingReservation.length > 0) {
      return res.status(400).json({ message: 'Seat already reserved.' });
    }

    // Insert reservation
    await db.query(
      'INSERT INTO reservations (user_id, trip_id, seat_number, meal) VALUES (?, ?, ?, ?)',
      [userId, trip_id, seat_number, meal]
    );

    res.json({ message: 'Trip reserved successfully.', seat_number });
  } catch (err) {
    console.error('Error reserving trip:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.get('/api/check-session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});




app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
