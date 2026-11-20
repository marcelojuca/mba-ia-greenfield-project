import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';

/** Boots AppModule with the same global pipes/filters as `main.ts`. */
export async function createE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface TestUser {
  email: string;
  accessToken: string;
}

/**
 * Registers, confirms and logs in a fresh user through the public auth API.
 * The confirmation token is captured from the mail service call.
 */
export async function createConfirmedUser(
  app: INestApplication<App>,
): Promise<TestUser> {
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'password123';

  // Same singleton AuthService uses to send the confirmation email.
  const mailService = app.get(MailService);
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, t: string) => {
      token = t;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const login: { body: { access_token: string } } = await request(
    app.getHttpServer(),
  )
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return { email, accessToken: login.body.access_token };
}
