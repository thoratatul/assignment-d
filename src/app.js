const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Op, Contract, Profile, Job } = require("./model");
global.Profile = Profile;
const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());

/**
 * FIX ME!
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const { id } = req.params;
  const { id: profileId } = req.profile;
  const contract = await Contract.findOne({
    where: {
      id,
      [Op.or]: [{ ContractorId: profileId }, { ClientId: profileId }],
    },
  });
  if (!contract) return res.status(404).json({ message: "No Records Found!" });
  res.json(contract);
});

app.get("/contracts", getProfile, async (req, res) => {
  const { id: profileId } = req.profile;
  const contracts = await Contract.findAll({
    where: {
      [Op.or]: [{ ContractorId: profileId }, { ClientId: profileId }],
      status: {
        [Op.ne]: "terminated",
      },
    },
  });

  if (!contracts.length)
    return res.status(404).json({ message: "No Records Found!" });
  res.json(contracts);
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { id: profileId } = req.profile;
  const jobs = await Job.findAll({
    include: [
      {
        attributes: [],
        model: Contract,
        required: true,
        where: {
          [Op.or]: [{ ContractorId: profileId }, { ClientId: profileId }],
          status: "in_progress",
        },
      },
    ],
    where: {
      paid: null,
    },
  });
  if (!jobs.length)
    return res.status(404).json({ message: "No Records Found!" });
  res.json(jobs);
});

app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { id: profileId, balance, type } = req.profile;
  const { job_id: jobId } = req.params;
  const job = await Job.findOne({
    where: { id: jobId, paid: null },
    include: [
      {
        model: Contract,
        where: { status: "in_progress", ClientId: profileId },
      },
    ],
  });
  const jobPrice = job.price;
  const contractorId = job.Contract.ContractorId;
  if (!job) return res.status(404).json({ message: "No Records Found!" });
  if (balance < jobPrice)
    res.status(404).json({ message: "Insufficient Balance!" });
  if (type !== "client")
    res.status(404).json({ message: "User Is Not Authorized To Pay!" });

  let response = {};

  const transaction = await sequelize.transaction();
  try {
    await Promise.all([
      Profile.update(
        { balance: sequelize.literal(`balance - ${jobPrice}`) },
        { where: { id: profileId } },
        { transaction }
      ),
      Profile.update(
        { balance: sequelize.literal(`balance + ${jobPrice}`) },
        { where: { id: contractorId } },
        { transaction }
      ),
      job.update({ paid: true, paymentDate: new Date() }, { transaction }),
    ]);
    await transaction.commit();
    response = { message: "Job Paid Successfully!" };
  } catch (error) {
    await transaction.rollback();
    response = { message: "Error! while paying for the job" };
  }
  res.json(response);
});

app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const { userId } = req.params;
  const { amount } = req.body;
  const transaction = await sequelize.transaction();
  try {
    const unpaidJobs = await Job.findAll(
      {
        attributes: {
          include: [
            [sequelize.fn("SUM", sequelize.col("price")), "totalPrice"],
          ],
        },
        include: [
          {
            attributes: [],
            model: Contract,
            required: true,
            where: {
              ClientId: userId,
              status: "in_progress",
            },
          },
        ],
        where: {
          paid: null,
        },
        raw: true,
      },
      { transaction }
    );

    const { totalPrice } = unpaidJobs[0];
    if (!totalPrice)
      return res.status(404).json({ message: "No Records Found!" });
    else {
      const maxDepositAmount = totalPrice * 0.25;
      let message = "";
      if (amount > maxDepositAmount) {
        message = "Maximum Deposit Amount Exceeded.";
      } else {
        await Profile.update(
          { balance: sequelize.literal(`balance + ${amount}`) },
          { where: { id: userId } },
          { transaction }
        );
        await transaction.commit();
        message = "Amount Deposited Successfully!";
      }
      return res.json({ message });
    }
  } catch (error) {
    await transaction.rollback();
    return res.status(404).json({ message: "Error! while depositing money." });
  }
});

app.get("/admin/best-profession", async (req, res) => {
  const { start, end } = req.query;
  const bestProfessions = await Profile.findAll({
    attributes: [
      "profession",
      [sequelize.fn("SUM", sequelize.col("price")), "earned"],
    ],
    include: [
      {
        model: Contract,
        as: "Contractor",
        attributes: [],
        required: true,
        include: [
          {
            model: Job,
            attributes: [],
            required: true,
            where: {
              paid: true,
              paymentDate: {
                [Op.gte]: new Date(start),
                [Op.lte]: new Date(end),
              },
            },
          },
        ],
      },
    ],
    where: {
      type: "contractor",
    },
    group: ["profession"],
    order: [[sequelize.col("earned"), "DESC"]],
    limit: 1,
    subQuery: false,
  });
  res.json(bestProfessions);
});

app.get("/admin/best-clients", async (req, res) => {
  try {
    const { start, end, limit } = req.query;
    const paidJobsForPeriod = await Job.findAll({
      include: [
        {
          model: Contract,
          as: "Contract",
          required: true,
          attributes: [],
          include: [
            {
              model: Profile,
              as: "Client",
              required: true,
              where: { type: "client" },
              attributes: [],
            },
          ],
        },
      ],
      where: {
        paid: true,
        paymentDate: {
          [Op.gte]: new Date(start),
          [Op.lte]: new Date(end),
        },
      },
      attributes: [
        [sequelize.col("Contract.ClientId"), "id"],
        [
          sequelize.fn(
            "concat",
            sequelize.col("Contract.Client.firstName"),
            " ",
            sequelize.col("Contract.Client.lastName")
          ),
          "fullName",
        ],
        [sequelize.fn("sum", sequelize.col("price")), "paid"],
      ],
      order: [[sequelize.col("paid"), "DESC"]],
      group: "Contract.ClientId",
      subQuery: false,
      limit,
    });

    res.json(paidJobsForPeriod);
  } catch (error) {
    console.log(error);
  }
});

app.get("/profiles", async (_, res) => {
  const profiles = await Profile.findAll();
  if (!profiles.length)
    return res.status(404).json({ message: "No Records Found!" });
  res.json(profiles);
});

app.get("/jobs", async (_, res) => {
  const jobs = await Job.findAll();
  if (!jobs.length)
    return res.status(404).json({ message: "No Records Found!" });
  res.json(jobs);
});

app.get("/allContracts", async (_, res) => {
  const contracts = await Contract.findAll();
  if (!contracts.length)
    return res.status(404).json({ message: "No Records Found!" });
  res.json(contracts);
});

module.exports = app;
