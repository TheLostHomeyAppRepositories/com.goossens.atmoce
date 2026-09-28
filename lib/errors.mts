export default class WrongGatewayError extends Error {

  constructor(expected: string, actual: string) {
    super(`Found gateway ${actual} at this address instead of ${expected}`);
    this.name = 'WrongGatewayError';
  }

}
