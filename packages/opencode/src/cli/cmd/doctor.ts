import { cmd } from "./cmd"

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose configuration, providers, models, and environment",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print the report as JSON",
      })
      .option("network", {
        type: "boolean",
        default: false,
        describe: "Probe configured provider endpoints for reachability",
      }),
  async handler(args) {
    const doctor = await import("@/doctor")
    const result = await doctor.Doctor.run({
      directory: process.cwd(),
      network: args.network,
    })
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    else console.log(doctor.Doctor.render(result))
    process.exitCode = doctor.Doctor.exitCode(result)
  },
})
