import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';

export interface AuthenticatedTestUser {
  access_token: string;
  user_id: string;
  email: string;
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  dataSource: DataSource,
  credentials: { email?: string; password?: string } = {},
): Promise<AuthenticatedTestUser> {
  const email =
    credentials.email ?? `user-${Date.now()}-${Math.random()}@example.com`;
  const password = credentials.password ?? 'password123';

  const registerResponse = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  const userId = (registerResponse.body as { id: string }).id;

  await dataSource.query(
    'UPDATE "users" SET is_confirmed = true WHERE id = $1',
    [userId],
  );

  const loginResponse = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    access_token: (loginResponse.body as { access_token: string }).access_token,
    user_id: userId,
    email,
  };
}
