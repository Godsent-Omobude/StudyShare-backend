import prisma from "../config/prisma.js";

export const listNotifications = async (req,res)=>{
  try{
    const notifications=await prisma.notification.findMany({where:{userId:req.user.id},include:{circle:{select:{id:true,name:true}}},orderBy:{createdAt:"desc"},take:50});
    const unread=await prisma.notification.count({where:{userId:req.user.id,read:false}});
    return res.json({notifications,unreadCount:unread});
  }catch(e){return res.status(500).json({message:e.message});}
};

export const markNotificationRead = async (req,res)=>{
  try{
    const id=Number.parseInt(req.params.id,10); if(Number.isNaN(id))return res.status(400).json({message:"Invalid notification ID."});
    const updated=await prisma.notification.updateMany({where:{id,userId:req.user.id},data:{read:true}});
    if(!updated.count)return res.status(404).json({message:"Notification not found."});
    return res.json({message:"Notification marked as read."});
  }catch(e){return res.status(500).json({message:e.message});}
};

export const markAllNotificationsRead = async (req,res)=>{
  try{await prisma.notification.updateMany({where:{userId:req.user.id,read:false},data:{read:true}});return res.json({message:"All notifications marked as read."});}
  catch(e){return res.status(500).json({message:e.message});}
};
