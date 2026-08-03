import prisma from "../config/prisma.js";

const username = process.argv[2];

if (!username) {
  console.error("Usage: node scripts/makeAdmin.js YOUR_USERNAME");
  process.exit(1);
}

const normalizedUsername = username.trim().toUpperCase();

try {
  const user = await prisma.user.findUnique({
    where: {
      username: normalizedUsername
    }
  });

  if (!user) {
    console.error(`User "${normalizedUsername}" was not found.`);
    process.exitCode = 1;
  } else {
    await prisma.user.update({
      where: {
        id: user.id
      },
      data: {
        role: "admin"
      }
    });

    console.log(`Success: ${normalizedUsername} is now an admin.`);
  }
} catch (error) {
  console.error("Failed to make user an admin:", error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
