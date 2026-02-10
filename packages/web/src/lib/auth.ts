import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

// Extend NextAuth types to include GitHub-specific user info
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      login?: string; // GitHub username
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number;
  }
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile, user }) {
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };

      const githubProfile = profile as { login?: string };
      const isAllowed = checkAccessAllowed(config, {
        githubUsername: githubProfile.login,
        email: user.email ?? undefined,
      });

      if (!isAllowed) {
        return false;
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        // expires_at is in seconds, convert to milliseconds (only set if provided)
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
      }
      if (profile) {
        // GitHub profile includes id (numeric) and login (username)
        const githubProfile = profile as { id?: number; login?: string };
        if (githubProfile.id) {
          token.githubUserId = githubProfile.id.toString();
        }
        if (githubProfile.login) {
          token.githubLogin = githubProfile.login;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.githubUserId as string) ?? session.user.id;
        session.user.login = token.githubLogin as string | undefined;
      }
      session.accessToken = token.accessToken as string | undefined;
      session.refreshToken = token.refreshToken as string | undefined;
      session.accessTokenExpiresAt = token.accessTokenExpiresAt as number | undefined;
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
});
