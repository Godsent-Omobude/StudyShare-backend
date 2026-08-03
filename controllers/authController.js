import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";

const generateToken = (id) => {

    return jwt.sign(

        { id },

        process.env.JWT_SECRET,

        {
            expiresIn: "30d"
        }

    );

};

export const register = async (req, res) => {

    try {

        const {

            fullName,

            username,

            password

        } = req.body;

        if (

            !fullName ||

            !username ||

            !password

        ) {

            return res.status(400).json({

                message: "Please fill in all fields."

            });

        }

        if (

            !username.toUpperCase().startsWith("BMS")

        ) {

            return res.status(400).json({

                message: "Username must start with BMS."

            });

        }

        const existingUser = await prisma.user.findUnique({

            where: {

                username: username.toUpperCase()

            }

        });

        if (existingUser) {

            return res.status(400).json({

                message: "Username already exists."

            });

        }

        const hashedPassword = await bcrypt.hash(

            password,

            10

        );

        const user = await prisma.user.create({

            data: {

                fullName,

                username: username.toUpperCase(),

                password: hashedPassword

            }

        });

        res.status(201).json({

            id: user.id,

            fullName: user.fullName,

            username: user.username,

            role: user.role,

            token: generateToken(user.id)

        });

    } catch (error) {

        res.status(500).json({

            message: error.message

        });

    }

};

export const login = async (req, res) => {

    try {

        const {

            username,

            password

        } = req.body;

        const user = await prisma.user.findUnique({

            where: {

                username: username.toUpperCase()

            }

        });

        if (!user) {

            return res.status(401).json({

                message: "Invalid username or password."

            });

        }

        const isMatch = await bcrypt.compare(

            password,

            user.password

        );

        if (!isMatch) {

            return res.status(401).json({

                message: "Invalid username or password."

            });

        }

        res.json({

            id: user.id,

            fullName: user.fullName,

            username: user.username,

            role: user.role,

            token: generateToken(user.id)

        });

    } catch (error) {

        res.status(500).json({

            message: error.message

        });

    }

};

export const getProfile = async (req, res) => {

    try {

        const user = await prisma.user.findUnique({

            where: {

                id: req.user.id

            },

            select: {

                id: true,

                fullName: true,

                username: true,

                role: true,

                createdAt: true

            }

        });

        res.json(user);

    } catch (error) {

        res.status(500).json({

            message: error.message

        });

    }

};