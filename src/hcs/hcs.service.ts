import { Injectable } from '@nestjs/common';
import { Request } from 'express'
import { ClientService } from '@hsuite/client';
import { Status, Transaction, LedgerId, PrivateKey, PublicKey } from '@hashgraph/sdk';
import { HederaClientHelper } from '@hsuite/helpers';
import { SmartConfigService } from '@hsuite/smart-config';
import { InjectModel } from '@nestjs/mongoose'
import { Types, Model } from 'mongoose';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
import { CreateTopicMessageDto } from './dto/create-topic-message.dto'
import { ReadTopicMessagesDto } from './dto/read-topic-messages.dto'
import { ReadMessagesDto, GroupBy } from './dto/read-messages.dto'
import { HcsTopic } from './schemas/hcs-topic.schema'
import { HcsTopicMessage } from './schemas/hcs-topic-message.schema'
import { Device } from '../devices/schemas/device.schema'
import { Wallet } from '../wallets/entities/wallet.entity'

@Injectable()
export class HcsService {
  private hederaClient: HederaClientHelper;

  constructor(
    @InjectModel(HcsTopicMessage.name) private readonly hcsTopicMessageModel: Model<HcsTopicMessage>,
    @InjectModel(Device.name) private readonly deviceModel: Model<Device>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<Wallet>,
    private readonly smartConfigService: SmartConfigService,
    private readonly clientService: ClientService
  ) {
    this.hederaClient = new HederaClientHelper(
      LedgerId.fromString(this.smartConfigService.getEnvironment()),
      this.smartConfigService.getOperator(),
      this.smartConfigService.getMirrorNode()
    );
  }

  async createDeviceTopics (createTopicDto: CreateTopicDto) {
    // return 'This action adds a new HCS topic';

    const { deviceUuid, devicePrivateKey } = createTopicDto
    // 3. Create 3 Hedera HCS records with different memo values
    const hcsPayload = {
      key:  PrivateKey.fromString(devicePrivateKey).publicKey.toString(), // Use the publicKey of the device in the HCS payload
      memo: "",  // Initialize memo as an empty string (to be set in the loop)
    };

    const topics: HcsTopic[] = [];
    const memos = [
      `${deviceUuid}_data`,         // 1st HCS record memo
      `${deviceUuid}_heartbeat`,    // 2nd HCS record memo
      `${deviceUuid}_error`,        // 3rd HCS record memo
    ];
  
    try {
      // Create 3 HCS records with different memos
      for (let i = 0; i < 3; i++) {
        // Assign the corresponding memo from the memos array
        
        hcsPayload.memo = memos[i];
  
        // Send the request to create the HCS record
        const hcsResponse = await this.clientService.axios.post(`/hcs`, hcsPayload);
        
        const hcstransaction = Transaction.fromBytes(new Uint8Array(Buffer.from(hcsResponse.data)));
  
        const hcssignTx = await hcstransaction.sign(PrivateKey.fromString(devicePrivateKey));

        const client = this.hederaClient.getClient();
        const hcssubmitTx = await hcssignTx.execute(client);
        const hcsreceipt = await hcssubmitTx.getReceipt(client);
      
        if (hcsreceipt.status == Status.Success) {
          //throw new Error(`Hedera HCS creation failed with status: ${hcsreceipt.status}`);
        }else{
          throw new Error(`Hedera HCS creation failed with status: ${hcsreceipt.status}`);
        }
        
        // Assuming the response contains the topicId in the body
        const hederaTopicId = hcsreceipt.topicId // Adjust if the response structure is different
  
        console.log('hcsreceipt_topicId',hederaTopicId.toString(), hcsPayload.memo);

        topics.push({
          hederaTopicId,
          hederaTopicName: hcsPayload.memo
        })
      }
  
      // Optionally, log all topicIds created
      console.log(`Topic IDs created: ${topics.map(t => t.hederaTopicId).join(', ')}`);

      return topics

    } catch (error) {
      console.error('Error creating HCS records:', error);
      throw new Error('Error creating HCS records for device');
    }
  }

  async createTopicMessage (uuid:string,topicId: string, createTopicMessageDto: CreateTopicMessageDto, req: Request) {
    console.log({ uuid, topicId, createTopicMessageDto })
    try {
      const device = await this.deviceModel.find({uuid},'+privateKey');
      const createdTopicMessageDoc = new this.hcsTopicMessageModel({
        ...createTopicMessageDto,
        topicId,
        deviceId: new Types.ObjectId(device[0]._id),
        ownerId: new Types.ObjectId(device[0].owner)
      })

      const createdTopicMessage = (await createdTopicMessageDoc.save()).toJSON()

      // Send the request to create the HCS record
      console.log(device)
      console.log(device[0].privateKey)
      const privatekey=PrivateKey.fromString(device[0].privateKey);
      console.log(privatekey.publicKey.toString());
      const hcsResponse = await this.clientService.axios.post(`/hcs/${topicId}/message`, {
        message: this.generateTopicMessage(createTopicMessageDto),
        submitKey: privatekey.publicKey
      });
              
      const hcstransaction = Transaction.fromBytes(new Uint8Array(Buffer.from(hcsResponse.data)));

      const hcssignTx = await hcstransaction.sign(privatekey);

      const client = this.hederaClient.getClient();
      const hcssubmitTx = await hcssignTx.execute(client);
      const hcsreceipt = await hcssubmitTx.getReceipt(client);
      console.log("Message recipt",hcsreceipt.topicSequenceNumber.toString(),hcsreceipt.serials)
      if (hcsreceipt.status !== Status.Success) {
        throw new Error(`Hedera HCS creation failed with status: ${hcsreceipt.status}`);
      }

      const sequenceNumber = Number(hcsreceipt.topicSequenceNumber.toString())
      await this.hcsTopicMessageModel.updateOne({ _id: createdTopicMessage._id }, { sequenceNumber })
      createdTopicMessage.sequenceNumber = sequenceNumber

      ////  based on device ownerid, get the wallet account id..
      const wallets = await this.walletModel.find({ owner: createdTopicMessage.ownerId })
      const walletId = wallets[0].account.id
      console.log('AccountID',walletId)
      const htsResponse = await this.clientService.axios.post(`/hts/transfer/token`, {
        token_id:'0.0.5149257',
        sender: this.smartConfigService.getOperator().accountId,
        receiver:walletId,
        amount:100000,
        decimals:0,
        memo:'Reward for data provider'
      });
    
      const htstransaction = Transaction.fromBytes(new Uint8Array(Buffer.from(htsResponse.data)));

      const htssignTx = await htstransaction.sign(PrivateKey.fromString(this.smartConfigService.getOperator().privateKey));

      const htssubmitTx = await htssignTx.execute(client);
      const htsreceipt = await htssubmitTx.getReceipt(client);
      if (htsreceipt.status !== Status.Success) {
        throw new Error(`Token Transfer failed: ${hcsreceipt.status}`);
      }
      return createdTopicMessage
    } catch (error) {
      console.error('Error creating HCS Message:', error);
      throw new Error(error.message);
    }
  }

  async findAllTopicMessages (topicId: string, readTopicMessagesDto: ReadTopicMessagesDto) {
    const { startDate, endDate } = readTopicMessagesDto

    const devices = await this.deviceModel.find({ 'hcsTopics.hederaTopicId': topicId })

    // Send the request to read the HCS topic messages
    const hcsResponse = await this.clientService.axios.get(`/hcs/restful/topics/${topicId}/messages`);
    const topicMessages = hcsResponse.data?.messages || []
    const data = []
    topicMessages.forEach(m => {
      const consensusTimestamp = Number(m.consensus_timestamp) * 1000 // Miliseconds
      const startTimestamp = new Date(startDate).getTime()
      const endTimestamp = new Date(endDate).getTime()
      if (consensusTimestamp >= startTimestamp && consensusTimestamp <= endTimestamp) {
        data.push({
          ...this.decodeBase64Message(m.message),
          id: m.sequence_number,
          topicId,
          deviceId: devices[0]._id,
          deviceUuid: devices[0].uuid,
          ownerId: devices[0].owner,
          createdAt: new Date(consensusTimestamp),
          updatedAt: new Date(consensusTimestamp)
        })
      }
    })
    return data
  }

  async findAllMessages (readMessagesDto: ReadMessagesDto) {
    const { startDate, endDate, deviceId, groupBy } = readMessagesDto

    if (groupBy === GroupBy.DAY && deviceId) {
      return await this.hcsTopicMessageModel.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(startDate),
              $lte: new Date(endDate)
            },
            deviceId: new Types.ObjectId(deviceId)
          }
        },
        {
          $group: {
            _id: {
              deviceId: '$deviceId',
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt'
                }
              }
            },
            averageTemperature: { $avg: '$temperature.value' },
            averageWindSpeed: { $avg: '$windSpeed.value' },
            averageWindDirection: { $avg: '$windDirection.value' },
            averageAtmPressure: { $avg: '$atmPressure.value' },
            averageAirQuality: { $avg: '$airQuality.value' },
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            date: '$_id.date',
            deviceId: '$_id.deviceId',
            averageTemperature: { $round: ['$averageTemperature', 2] },
            averageWindSpeed: { $round: ['$averageWindSpeed', 2] },
            averageWindDirection: { $round: ['$averageWindDirection', 2] },
            averageAtmPressure: { $round: ['$averageAtmPressure', 2] },
            averageAirQuality: { $round: ['$averageAirQuality', 2] },
            count: 1
          }
        },
        {
          $sort: { date: 1 }
        }
      ])
    }

    if (groupBy === GroupBy.DAY) {
      return await this.hcsTopicMessageModel.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(startDate),
              $lte: new Date(endDate)
            }
          }
        },
        {
          $group: {
            _id: {
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt'
                }
              }
            },
            averageTemperature: { $avg: '$temperature.value' },
            averageWindSpeed: { $avg: '$windSpeed.value' },
            averageWindDirection: { $avg: '$windDirection.value' },
            averageAtmPressure: { $avg: '$atmPressure.value' },
            averageAirQuality: { $avg: '$airQuality.value' },
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            date: '$_id.date',
            averageTemperature: { $round: ['$averageTemperature', 2] },
            averageWindSpeed: { $round: ['$averageWindSpeed', 2] },
            averageWindDirection: { $round: ['$averageWindDirection', 2] },
            averageAtmPressure: { $round: ['$averageAtmPressure', 2] },
            averageAirQuality: { $round: ['$averageAirQuality', 2] },
            count: 1
          }
        },
        {
          $sort: { date: 1 }
        }
      ])
    }

    return await this.hcsTopicMessageModel.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      },
      deviceId: deviceId ? new Types.ObjectId(deviceId) : undefined
    })
  }

  findAll() {
    return `This action returns all HCS topics`;
  }

  findOne(id: number) {
    return `This action returns a #${id} HCS topic`;
  }

  update(id: number, updateTopicDto: UpdateTopicDto) {
    return `This action updates a #${id} HCS topic`;
  }

  remove(id: number) {
    return `This action removes a #${id} HCS topic`;
  }

  private generateTopicMessage (createTopicMessageDto: CreateTopicMessageDto) {
    const payloadKeys = ['temperature', 'atmPressure', 'windSpeed', 'windDirection', 'airQuality']
    const payload = Object.keys(createTopicMessageDto).reduce((acc, key) => {
      if (payloadKeys.includes(key)) {
        acc[key] = createTopicMessageDto[key] || null
      }
      return acc
    }, {})
    const message = JSON.stringify(payload)
    return message
  }

  private decodeBase64Message (base64Message: string) {
    const decodedMessage = Buffer.from(base64Message, 'base64').toString('utf-8')
    return JSON.parse(decodedMessage)
  }
}
