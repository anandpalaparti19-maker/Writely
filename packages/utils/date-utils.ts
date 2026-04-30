import { format, isAfter, isBefore } from 'date-fns';

export const formatDate = (date: Date, pattern: string = 'PP') => {
  return format(date, pattern);
};

export const isPast = (date: Date) => {
  return isBefore(date, new Date());
};

export const isFuture = (date: Date) => {
  return isAfter(date, new Date());
};
