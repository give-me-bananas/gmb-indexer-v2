import { JsonRpcProvider } from "@ethersproject/providers";
import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { getLatestStoredBlock } from "./block-indexer";

const rpcUrl = process.env.RPC_URL!;
const maxNumberOfBlockToIndex = parseInt(
  process.env.MAX_NUMBER_OF_BLOCK_TO_INDEX ?? "50"
);

async function main(db: PrismaClient, provider: JsonRpcProvider) {
  while (true) {
    const latestStoredTransferBlock = await getLatestStoredTransferBlock(db);
    if (latestStoredTransferBlock) {
      // get latest stored block
      const latestStoredBlock = await getLatestStoredBlock(db);
      if (!latestStoredBlock) {
        // stored block is empty, we delete everything
        await handleReorg(db, 0);
        continue;
      }

      const isReorg =
        latestStoredTransferBlock.blockHash.toLowerCase() !==
        latestStoredBlock.blockHash.toLowerCase();

      if (isReorg) {
        // reorg for one block
        await handleReorg(db, latestStoredTransferBlock.blockNumber);
        continue;
      }
    }
  }
}

(async () => {
  console.log("Start indexing");

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

async function handleReorg(db: PrismaClient, reorgFromBlockNumber: number) {
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

async function insertOneBlock(db: PrismaClient) {
    
}
