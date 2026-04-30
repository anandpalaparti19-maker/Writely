export const KafkaTopics = {
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.failed',
};

export const produceEvent = async (topic: string, data: any) => {
  console.log(`Producing to ${topic}:`, data);
  // Kafka producer logic here
};
