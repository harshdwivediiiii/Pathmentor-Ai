"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { generateAIInsights } from "./dashboard";

/**
 * Fetch Clerk user profile from Clerk API (works in all environments)
 */
async function fetchClerkUser(userId) {
  const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
  if (!CLERK_SECRET_KEY) throw new Error("Missing Clerk secret key");

  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) throw new Error("Failed to fetch Clerk user");
  return res.json();
}

async function getOrCreateUser(userId) {
  // 1. Try to find by clerkUserId
  let user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (user) return user;

  // 2. Fetch Clerk user and their email
  const clerkUser = await fetchClerkUser(userId);
  const email =
    clerkUser.email_addresses?.find(e => e.id === clerkUser.primary_email_address_id)?.email_address ||
    clerkUser.email_addresses?.[0]?.email_address;

  if (!email) throw new Error("Could not fetch email from Clerk for user creation");

  // 3. Try to find user by email (in case they signed up before with another login method)
  user = await db.user.findUnique({
    where: { email },
  });

  if (user) {
    // 4. If user with this email exists, update clerkUserId if needed
    if (!user.clerkUserId) {
      user = await db.user.update({
        where: { email },
        data: { clerkUserId: userId },
      });
    }
    return user;
  }

  // 5. If user not found, create a new user
  try {
    user = await db.user.create({
      data: {
        clerkUserId: userId,
        email,
        industry: null,
        experience: null,
        bio: "",
        skills: [],
      },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      // Handle unique constraint violation
      user = await db.user.findUnique({
        where: { email },
      });
    } else {
      throw error; // Rethrow other errors
    }
  }

  return user;
}

export async function updateUser(data) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await getOrCreateUser(userId);

  try {
    const result = await db.$transaction(
      async (tx) => {
        let industryInsight = await tx.industryInsight.findUnique({
          where: { industry: data.industry },
        });
        if (!industryInsight) {
          const insights = await generateAIInsights(data.industry);
          industryInsight = await tx.industryInsight.create({
            data: {
              industry: data.industry,
              ...insights,
              nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
          });
        }

        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            industry: data.industry,
            experience: data.experience,
            bio: data.bio,
            skills: data.skills,
          },
        });

        return { updatedUser, industryInsight };
      },
      { timeout: 10000 }
    );

    revalidatePath("/");
    return result.updatedUser;
  } catch (error) {
    console.error("Error updating user and industry:", error.message);
    throw new Error("Failed to update profile");
  }
}

export async function getUserOnboardingStatus() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  try {
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
      select: { industry: true },
    });

    return {
      isOnboarded: !!user?.industry,
    };
  } catch (error) {
    console.error("Error checking onboarding status:", error);
    throw new Error("Failed to check onboarding status");
  }
}