import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
})

const prisma = new PrismaClient({ adapter })

async function promoteToAdmin(email: string) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.error(`User not found: ${email}`)
    process.exit(1)
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role: 'admin' },
  })

  console.log(`Promoted ${email} (id: ${user.id}) to admin`)
}

const email = process.argv[2]

if (!email) {
  console.error('Usage: bun run scripts/promote-admin.ts <email>')
  process.exit(1)
}

promoteToAdmin(email)
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
