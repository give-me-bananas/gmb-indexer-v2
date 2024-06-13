import { JsonRpcProvider } from "@ethersproject/providers";
import { PrismaClient } from "@prisma/client";
import { BigNumber, Contract, ethers, utils } from "ethers";
import { getLatestStoredBlock } from "./block-indexer";
import * as BananaController from "../BananaController.json";
import { AbiCoder } from "ethers/lib/utils";
import { normalizeL1ContractAddress } from "../utils";

const rpcUrl = process.env.RPC_URL!;
const maxNumberOfBlockToIndex = parseInt(
  process.env.MAX_NUMBER_OF_BLOCK_TO_INDEX ?? "50"
);
const indexFromBlockNumber = parseInt(
  process.env.INDEX_FROM_BLOCK_NUMBER ?? "0"
);
const bananaControllerAddress = process.env.BANANA_CONTROLLER_ADDRESS!;
const notificationBaseUrl = process.env.NOTIFICATION_BASE_URL!;

const abi = BananaController.abi;

async function main(db: PrismaClient, provider: JsonRpcProvider) {
  const bananaControllerContract = new Contract(
    bananaControllerAddress,
    abi,
    provider
  );

  const donationFilter = bananaControllerContract.filters.Donate();

  while (true) {
    const latestStoredTransferBlock = await getLatestStoredTransferBlock(db);
    if (latestStoredTransferBlock) {
      const storedBlockAt = await getStoredBlockAt(
        db,
        latestStoredTransferBlock.blockNumber
      );
      if (!storedBlockAt) {
        // stored block not found
        await handleReorg(db, latestStoredTransferBlock.blockNumber);
        continue;
      }

      const isReorg =
        latestStoredTransferBlock.blockHash.toLowerCase() !==
        storedBlockAt.blockHash.toLowerCase();

      if (isReorg) {
        // reorg for one block
        await handleReorg(db, latestStoredTransferBlock.blockNumber);
        continue;
      }
    }

    // get latest stored block
    const latestStoredBlock = await getLatestStoredBlock(db);
    if (
      latestStoredTransferBlock &&
      (!latestStoredBlock ||
        latestStoredTransferBlock.blockNumber > latestStoredBlock.blockNumber)
    ) {
      const deleteFrom = latestStoredBlock ? latestStoredBlock.blockNumber : 0;
      await handleReorg(db, deleteFrom);
      continue;
    }

    // index until latest block or until max blockNumber to index,
    // whichever is smaller
    const numOfBlockToIndex = Math.min(
      maxNumberOfBlockToIndex,
      latestStoredBlock!.blockNumber -
        (latestStoredTransferBlock ? latestStoredTransferBlock?.blockNumber : 0)
    );

    for (let i = 0; i <= numOfBlockToIndex; i++) {
      const blockNumber =
        (latestStoredTransferBlock
          ? latestStoredTransferBlock.blockNumber + 1
          : indexFromBlockNumber) + i;

      console.log(`Indexing block ${blockNumber}`);
      const storeBlockAt = await getStoredBlockAt(db, blockNumber);
      if (!storeBlockAt) {
        break;
      }

      const filter = {
        ...donationFilter,
        blockHash: storeBlockAt.blockHash,
      };
      const logs = await provider.getLogs(filter);
      const donationHistories: DonationHistory[] = [];
      for (const log of logs) {
        const donor = normalizeL1ContractAddress(log.topics[1]);
        const recipient = normalizeL1ContractAddress(log.topics[2]);
        const erc20TokenAddress = normalizeL1ContractAddress(log.topics[3]);

        const values = new AbiCoder().decode(
          ["uint256", "uint256", "string", "string"],
          log.data
        );
        const netDonation = BigNumber.from(values[0]);
        const commission = BigNumber.from(values[1]);
        const donorName: string = values[2];
        const message: string = values[3];

        console.log(
          `At block ${blockNumber}, ${donor} has donated ${netDonation}`
        );
        donationHistories.push({
          blockNumber,
          blockHash: storeBlockAt.blockHash,
          donor: donor,
          recipient: recipient,
          erc20TokenAddress: erc20TokenAddress,
          netDonation: netDonation.toString(),
          commission: commission.toString(),
          donorName,
          message,
        });
      }

      await insertOneBlock(
        db,
        blockNumber,
        storeBlockAt.blockHash,
        donationHistories
      );

      // // notify streamer of incoming alert
      // await notifyStreamer(
      //   erc20TokenAddress,
      //   recipient,
      //   donorName,
      //   message,
      //   netDonation.add(commission)
      // );
      // }
    }
  }
}

(async () => {
  console.log("Start indexing transfer-indexer");

  const prisma = new PrismaClient();
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  await main(prisma, provider);
})();

async function getLatestStoredTransferBlock(db: PrismaClient) {
  const latestBlock = await db.transferLatestBlockNumber.findFirst({
    orderBy: {
      blockNumber: "desc",
    },
  });

  return latestBlock;
}

async function getStoredBlockAt(db: PrismaClient, blockNumber: number) {
  const block = await db.latestBlockNumber.findFirst({
    where: {
      blockNumber: blockNumber,
    },
  });

  return block;
}
async function handleReorg(db: PrismaClient, reorgFromBlockNumber: number) {
  console.log(`Reorg occur from ${reorgFromBlockNumber}`);
  await db.$transaction([
    db.transferLatestBlockNumber.deleteMany({
      where: {
        blockNumber: {
          gte: reorgFromBlockNumber,
        },
      },
    }),
    db.donationHistory.deleteMany({
      where: {
        blockNumber: {
          gte: reorgFromBlockNumber,
        },
      },
    }),
  ]);
}

async function insertOneBlock(
  db: PrismaClient,
  blockNumber: number,
  blockHash: string,
  donationHistories: DonationHistory[]
) {
  const insertTransferBlockQuery = db.transferLatestBlockNumber.create({
    data: {
      blockHash,
      blockNumber,
    },
  });

  const insertDonationHistoriesQuery = donationHistories.map((h) => {
    return db.donationHistory.create({
      data: {
        blockNumber: h.blockNumber,
        donor: h.donor,
        recipient: h.recipient,
        erc20TokenAddress: h.erc20TokenAddress,
        netDonation: h.netDonation,
        commission: h.commission,
        donorName: h.donorName,
        message: h.message,
      },
    });
  });

  await db.$transaction([
    insertTransferBlockQuery,
    ...insertDonationHistoriesQuery,
  ]);
}

type DonationHistory = {
  blockNumber: number;
  blockHash: string;
  donor: string;
  recipient: string;
  erc20TokenAddress: string;
  netDonation: string;
  commission: string;
  donorName: string;
  message: string;
};

async function notifyStreamer(
  erc20TokenAddress: string,
  streamerAddress: string,
  donorName: string,
  message: string,
  amount: BigNumber
) {
  // /users/:userId/alerts
  const url = new URL(`users/${streamerAddress}/alerts`, notificationBaseUrl);

  const erc20Detail = erc20TokenDetailMapping.get(
    normalizeL1ContractAddress(erc20TokenAddress)
  )!;
  if (erc20Detail === undefined) {
    // Do nothing if not tracking it.
    return;
  }

  const divisor = BigNumber.from(10).pow(erc20Detail.decimal);
  const normalizedAmount = amount.div(divisor);

  const data = {
    senderName: donorName,
    message,
    tipAmount: `${erc20Detail.symbol}${normalizedAmount}`,
  };

  const customHeaders = {
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: customHeaders,
    body: JSON.stringify(data),
  });
}
