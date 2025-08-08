const router = require("express").Router();
const { Users, Calendar, DailyWorkout, TrainingPrograms } = require("../models");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sequelize = require("../config/connection");
const tokenauth = require("../utils/tokenauth");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const JWT_SECRET = process.env.JWT_SECRET;
