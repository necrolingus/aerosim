import type { AerodynamicTelemetry, FluidPreset, TunnelDimensions } from '../core/types';

/**
 * Computes dimensionless fluid numbers (Reynolds, Mach), dynamic pressure,
 * wind tunnel blockage ratio, and flow regime classification.
 */
export function computeAerodynamicTelemetry(params: {
  windSpeed: number; // m/s
  characteristicLength: number; // m (L_ref)
  frontalArea: number; // m^2 (A_ref)
  fluid: FluidPreset;
  tunnel: TunnelDimensions;
}): AerodynamicTelemetry {
  const { windSpeed, characteristicLength, frontalArea, fluid, tunnel } = params;

  const safeSpeed = Math.max(0, windSpeed);
  const safeLength = Math.max(1e-6, characteristicLength);
  const safeNu = Math.max(1e-12, fluid.kinematicViscosity);
  const safeSound = Math.max(1, fluid.speedOfSound);

  // Re = (U * L) / nu
  const reynoldsNumber = (safeSpeed * safeLength) / safeNu;

  // Ma = U / c
  const machNumber = safeSpeed / safeSound;

  // Dynamic pressure q = 0.5 * rho * U^2 (Pascals = N/m^2)
  const dynamicPressurePa = 0.5 * fluid.density * safeSpeed * safeSpeed;

  // Tunnel cross-sectional area normal to +X wind is Width (Z) * Height (Y)
  const tunnelCrossSection = Math.max(1e-4, tunnel.width * tunnel.height);
  const blockageRatioPercent = (frontalArea / tunnelCrossSection) * 100;

  let flowRegime: AerodynamicTelemetry['flowRegime'] = 'Laminar';
  if (reynoldsNumber >= 3.5e5) {
    flowRegime = 'Turbulent (Supercritical)';
  } else if (reynoldsNumber >= 2000) {
    flowRegime = 'Turbulent (Subcritical)';
  } else if (reynoldsNumber >= 500) {
    flowRegime = 'Transitional';
  }

  return {
    reynoldsNumber,
    machNumber,
    dynamicPressurePa,
    frontalAreaM2: frontalArea,
    characteristicLengthM: characteristicLength,
    blockageRatioPercent,
    flowRegime,
  };
}

/**
 * Converts physical drag force F_d (Newtons) to dimensionless Drag Coefficient C_d:
 * C_d = 2 * F_d / (rho * U^2 * A_ref)
 */
export function forceToCoefficient(
  forceNewtons: number,
  density: number,
  windSpeed: number,
  referenceAreaM2: number
): number {
  const denom = 0.5 * density * windSpeed * windSpeed * referenceAreaM2;
  if (denom <= 1e-12) return 0;
  return forceNewtons / denom;
}

/**
 * Converts dimensionless coefficient (C_d or C_l) to physical force in Newtons:
 * F = 0.5 * rho * U^2 * A_ref * C
 */
export function coefficientToForce(
  coefficient: number,
  density: number,
  windSpeed: number,
  referenceAreaM2: number
): number {
  return 0.5 * density * windSpeed * windSpeed * referenceAreaM2 * coefficient;
}
