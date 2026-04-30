import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const orderCreationSchema = z.object({
  title: z.string().min(5).max(100),
  description: z.string().min(20),
  budget: z.number().positive(),
  deadline: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: "Invalid date format",
  }),
});
