const router = require("express").Router();
const { Users, Calendar, DailyWorkout, TrainingPrograms } = require("../models");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sequelize = require("../config/connection");
const tokenauth = require("../utils/tokenauth");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const JWT_SECRET = process.env.JWT_SECRET;


// create a new user

router.post("/register", async (req, res) => {
    try {
        const { firstName, lastName, email, password, profilePicture } = req.body;

        // Check if user already exists
        const existingUser = await Users.findOne({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        // Create new user
        const newUser = await Users.create({
            id: uuidv4(),
            firstName,
            lastName,
            email,
            password,
            profilePicture
        });

        // Generate JWT token
        const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: "1h" });

        res.status(201).json({ token, user: newUser });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// User login

router.post("/login", async (req, res) => {
    try {
        console.log("Request Body:", req.body);
    
        if (!req.body.email || !req.body.password) {
          return res.status(400).json({ message: "Missing userName or password" });
        }

        const user = await Users.findOne({
            where: { email: req.body.email },
          });
      
          if (!user) {
            return res.status(400).json({ message: "User not found" });
          }

          const validPassword = await bcrypt.compare(
            req.body.password,
            user.password
          );
      
          if (!validPassword) {
            return res.status(400).json({ message: "Invalid password" });
          }

          // Generate JWT token
            const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "1h" });

            res.status(200).json({ token, user });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// logout user
router.post("/logout", tokenauth, async (req, res) => {
    try {
        // Invalidate the token by simply not returning it
        res.status(200).json({ message: "User logged out successfully" });
    } catch (error) {
        console.error("Logout error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Get user profile by ID
router.get("/:id", async (req, res) => {
    try {
        const user = await Users.findByPk(req.params.id, {
            attributes: { exclude: ["password"] },
        });

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Update user profile
router.put("/:id", tokenauth, async (req, res) => {
    try {
        const user = await Users.findByPk(req.params.id);

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Update user details
        const updatedUser = await user.update(req.body);

        res.status(200).json(updatedUser);
    } catch (error) {
        console.error("Error updating user profile:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});



module.exports = router;
    