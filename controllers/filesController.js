import prisma from "../config/prisma.js";
import path from "path";

export const uploadFile = async (req, res) => {

    const { title, description, courseCode, type } = req.body;

    if (!req.file) {
        return res.status(400).json({
            message: "Please upload a file."
        });
    }

    try {

        const file = await prisma.file.create({

            data: {

                title,

                description,

                courseCode: courseCode
                    ? courseCode.toUpperCase()
                    : null,

                type,

                filename: req.file.filename,

                filepath: req.file.path,

                mimetype: req.file.mimetype,

                uploadedBy: req.user.id,

                uploaderName: req.user.fullName

            }

        });

        res.status(201).json(file);

    } catch (error) {

        res.status(500).json({
            message: error.message
        });

    }

};

export const getFiles = async (req, res) => {

    try {

        const files = await prisma.file.findMany({

            orderBy: {
                createdAt: "desc"
            }

        });

        res.json(files);

    } catch (error) {

        res.status(500).json({
            message: error.message
        });

    }

};

export const downloadFile = async (req, res) => {

    try {

        const id = Number(req.params.id);

        const file = await prisma.file.findUnique({

            where: {
                id
            }

        });

        if (!file) {

            return res.status(404).json({

                message: "File not found."

            });

        }

        await prisma.file.update({

            where: {
                id
            },

            data: {

                downloads: {

                    increment: 1

                }

            }

        });

        res.download(

            file.filepath,

            file.title + path.extname(file.filename)

        );

    } catch (error) {

        res.status(500).json({

            message: error.message

        });

    }

};